import { describe, it, expect, vi } from "vitest";

import { StartupRebuildCoordinator } from "./startup-rebuild-coordinator.js";
import { ProjectionRebuildContext } from "./projection-rebuild-context.js";
import { CheckpointStore } from "./checkpoint-store.js";
import {
    createFakeLogger,
    createFakeUnitOfWork,
    createStoredEvents,
} from "./test-helpers.fixtures.js";

import type { IPostgresReadModel } from "./read-model.js";
import type { ReadableEventStore } from "./types.js";
import type { StoredEvent } from "@hexaijs/core";

function createFakeReadModel(
    name: string,
    overrides: Partial<IPostgresReadModel> = {}
): IPostgresReadModel {
    return {
        name,
        version: 1,
        canHandle: vi.fn(() => true),
        apply: vi.fn(async () => {}),
        reset: vi.fn(async () => {}),
        ...overrides,
    };
}

function createFakeEventStore(events: StoredEvent[]): ReadableEventStore {
    return {
        stream: vi.fn(async function* (afterPosition: number) {
            for (const event of events) {
                if (event.position > afterPosition) yield event;
            }
        }),
        getLastPosition: vi.fn(async () => events.at(-1)?.position ?? 0),
        getEventCount: vi.fn(async () => events.length),
    };
}

function createRebuildContext(
    readModel: IPostgresReadModel,
    opts: {
        batchSize?: number;
        maxRetries?: number;
        targetPosition?: number;
        totalEvents?: number;
        startPosition?: number;
    } = {}
): ProjectionRebuildContext {
    const checkpointStore = new CheckpointStore();
    vi.spyOn(checkpointStore, "save").mockResolvedValue(undefined);
    vi.spyOn(checkpointStore, "updateStatus").mockResolvedValue(undefined);

    return new ProjectionRebuildContext(
        readModel,
        checkpointStore,
        createFakeUnitOfWork(),
        createFakeLogger(),
        {
            batchSize: opts.batchSize ?? 3,
            maxRetries: opts.maxRetries ?? 3,
            targetPosition: opts.targetPosition ?? 10,
            totalEvents: opts.totalEvents ?? 10,
            startPosition: opts.startPosition ?? 0,
        }
    );
}

function createCoordinator(
    contexts: ProjectionRebuildContext[],
    eventStore: ReadableEventStore,
    opts: {
        startPosition?: number;
        targetPosition?: number;
        streamBatchSize?: number;
        flushConcurrency?: number;
    } = {}
): StartupRebuildCoordinator {
    return new StartupRebuildCoordinator(
        contexts,
        opts.startPosition ?? 0,
        opts.targetPosition ?? 10,
        eventStore,
        createFakeLogger(),
        opts.streamBatchSize ?? 100,
        opts.flushConcurrency ?? 4
    );
}

describe("StartupRebuildCoordinator", () => {
    it("returns empty result for empty event store", async () => {
        const readModel = createFakeReadModel("projection-a");
        const ctx = createRebuildContext(readModel, {
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore([]);

        const coordinator = createCoordinator([ctx], eventStore, {
            targetPosition: 10,
        });
        const result = await coordinator.run();

        // No events were streamed, so no context reached targetPosition
        expect(result.completed).toEqual([]);
        expect(result.isolated).toEqual([]);
    });

    it("completes single projection rebuild", async () => {
        const events = createStoredEvents(10);
        const readModel = createFakeReadModel("projection-a");
        const ctx = createRebuildContext(readModel, {
            batchSize: 5,
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctx], eventStore, {
            targetPosition: 10,
        });
        const result = await coordinator.run();

        expect(result.completed).toEqual(["projection-a"]);
        expect(result.isolated).toEqual([]);
    });

    it("completes multiple projections", async () => {
        const events = createStoredEvents(10);
        const readModelA = createFakeReadModel("projection-a");
        const readModelB = createFakeReadModel("projection-b");
        const ctxA = createRebuildContext(readModelA, {
            batchSize: 5,
            targetPosition: 10,
            totalEvents: 10,
        });
        const ctxB = createRebuildContext(readModelB, {
            batchSize: 5,
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctxA, ctxB], eventStore, {
            targetPosition: 10,
        });
        const result = await coordinator.run();

        expect(result.completed).toContain("projection-a");
        expect(result.completed).toContain("projection-b");
        expect(result.isolated).toEqual([]);
    });

    it("isolates failing projection while others continue", async () => {
        const events = createStoredEvents(10);
        const failingReadModel = createFakeReadModel("failing-projection", {
            apply: vi.fn(async () => {
                throw new Error("permanent failure");
            }),
        });
        const healthyReadModel = createFakeReadModel("healthy-projection");

        const failingCtx = createRebuildContext(failingReadModel, {
            batchSize: 3,
            maxRetries: 1,
            targetPosition: 10,
            totalEvents: 10,
        });
        const healthyCtx = createRebuildContext(healthyReadModel, {
            batchSize: 3,
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator(
            [failingCtx, healthyCtx],
            eventStore,
            {
                targetPosition: 10,
            }
        );
        const result = await coordinator.run();

        expect(result.isolated).toEqual(["failing-projection"]);
        expect(result.completed).toEqual(["healthy-projection"]);
    });

    it("isolates all projections when all fail", async () => {
        const events = createStoredEvents(10);
        const failingA = createFakeReadModel("fail-a", {
            apply: vi.fn(async () => {
                throw new Error("fail");
            }),
        });
        const failingB = createFakeReadModel("fail-b", {
            apply: vi.fn(async () => {
                throw new Error("fail");
            }),
        });

        const ctxA = createRebuildContext(failingA, {
            batchSize: 3,
            maxRetries: 1,
            targetPosition: 10,
            totalEvents: 10,
        });
        const ctxB = createRebuildContext(failingB, {
            batchSize: 3,
            maxRetries: 1,
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctxA, ctxB], eventStore, {
            targetPosition: 10,
        });
        const result = await coordinator.run();

        expect(result.completed).toEqual([]);
        expect(result.isolated).toContain("fail-a");
        expect(result.isolated).toContain("fail-b");
    });

    it("respects targetPosition and does not distribute events beyond it", async () => {
        const events = createStoredEvents(20);
        const readModel = createFakeReadModel("bounded-projection");
        const ctx = createRebuildContext(readModel, {
            batchSize: 5,
            targetPosition: 10,
            totalEvents: 10,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctx], eventStore, {
            targetPosition: 10,
        });
        const result = await coordinator.run();

        expect(result.completed).toEqual(["bounded-projection"]);
        // readModel.apply should not have been called for events beyond position 10
        const appliedEvents = (readModel.apply as ReturnType<typeof vi.fn>).mock
            .calls;
        for (const [storedEvent] of appliedEvents) {
            expect(storedEvent.position).toBeLessThanOrEqual(10);
        }
    });

    it("serializes flushes when flushConcurrency is 1", async () => {
        const executionLog: string[] = [];
        const events = createStoredEvents(6);

        const readModelA = createFakeReadModel("serial-a", {
            apply: vi.fn(async () => {
                executionLog.push("a-start");
                await new Promise((r) => setTimeout(r, 10));
                executionLog.push("a-end");
            }),
        });
        const readModelB = createFakeReadModel("serial-b", {
            apply: vi.fn(async () => {
                executionLog.push("b-start");
                await new Promise((r) => setTimeout(r, 10));
                executionLog.push("b-end");
            }),
        });

        const ctxA = createRebuildContext(readModelA, {
            batchSize: 3,
            targetPosition: 6,
            totalEvents: 6,
        });
        const ctxB = createRebuildContext(readModelB, {
            batchSize: 3,
            targetPosition: 6,
            totalEvents: 6,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctxA, ctxB], eventStore, {
            targetPosition: 6,
            flushConcurrency: 1,
        });
        await coordinator.run();

        // With concurrency=1, flushes are serialized: all a-ops complete before b-ops start (or vice versa)
        const firstAEnd = executionLog.indexOf("a-end");
        const firstBStart = executionLog.indexOf("b-start");
        const firstBEnd = executionLog.indexOf("b-end");
        const firstAStart = executionLog.indexOf("a-start");

        // One projection's batch must finish before the other starts
        const aBeforeB = firstAEnd < firstBStart;
        const bBeforeA = firstBEnd < firstAStart;
        expect(aBeforeB || bBeforeA).toBe(true);
    });

    it("returns empty result when given zero contexts", async () => {
        const events = createStoredEvents(5);
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([], eventStore);
        const result = await coordinator.run();

        expect(result.completed).toEqual([]);
        expect(result.isolated).toEqual([]);
    });

    it("resumes from startPosition and only processes later events", async () => {
        const events = createStoredEvents(10);
        const readModel = createFakeReadModel("resume-projection");
        const ctx = createRebuildContext(readModel, {
            batchSize: 3,
            targetPosition: 10,
            totalEvents: 10,
            startPosition: 5,
        });
        const eventStore = createFakeEventStore(events);

        const coordinator = createCoordinator([ctx], eventStore, {
            startPosition: 5,
            targetPosition: 10,
        });
        const result = await coordinator.run();

        expect(result.completed).toEqual(["resume-projection"]);
        // Only events 6-10 should have been applied (5 events)
        expect(readModel.apply).toHaveBeenCalledTimes(5);
    });
});
