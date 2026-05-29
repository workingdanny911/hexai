import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ProjectionEngine } from "./projection-engine.js";
import { CheckpointStore } from "./checkpoint-store.js";
import {
    createFakeLogger,
    createFakeUnitOfWork,
    createStoredEvents,
} from "./test-helpers.fixtures.js";

import type { IPostgresReadModel } from "./read-model.js";
import type { ProjectionEngineLogger, ReadableEventStore } from "./types.js";
import type { StoredEvent } from "@hexaijs/core";
import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";

function createFakeReadModel(name: string, version = 1): IPostgresReadModel {
    return {
        name,
        version,
        canHandle: vi.fn(() => true),
        apply: vi.fn(async () => {}),
        reset: vi.fn(async () => {}),
    };
}

function createFakeEventStore(events: StoredEvent[] = []): ReadableEventStore {
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

describe("ProjectionEngine", () => {
    let unitOfWork: PostgresUnitOfWork;
    let logger: ProjectionEngineLogger;

    beforeEach(() => {
        unitOfWork = createFakeUnitOfWork();
        logger = createFakeLogger();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers a model and polls events through the runner", async () => {
        const events = createStoredEvents(3);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("test-model");

        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
        engine.register(readModel);

        await engine.poll();

        expect(eventStore.stream).toHaveBeenCalled();
        expect(readModel.apply).toHaveBeenCalledTimes(3);
    });

    it("returns status for all runners", async () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);

        engine.register(createFakeReadModel("model-a", 1));
        engine.register(createFakeReadModel("model-b", 2));

        const statuses = engine.getStatus();
        expect(statuses).toHaveLength(2);
        expect(statuses.map((s) => s.name)).toEqual(["model-a", "model-b"]);
    });

    it("skips already-processed events for each runner", async () => {
        const events = createStoredEvents(5);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("test-model");
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
        engine.register(readModel);

        await engine.poll();
        expect(readModel.apply).toHaveBeenCalledTimes(5);

        vi.mocked(readModel.apply).mockClear();
        await engine.poll();
        expect(readModel.apply).not.toHaveBeenCalled();
    });

    it("does not feed later events to a retrying runner in the same poll", async () => {
        const events = createStoredEvents(2);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("retry-barrier");
        vi.mocked(readModel.apply)
            .mockRejectedValueOnce(new Error("transient failure"))
            .mockResolvedValue(undefined);

        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
        engine.register(readModel);

        await engine.poll();

        expect(readModel.apply).toHaveBeenCalledTimes(1);
        expect(engine.getStatus()[0]).toMatchObject({
            health: "retrying",
            lastPosition: 0,
        });

        await engine.poll();

        expect(readModel.apply).toHaveBeenCalledTimes(3);
        expect(engine.getStatus()[0]).toMatchObject({
            health: "healthy",
            lastPosition: 2,
        });
    });

    it("throws when registering after start", async () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        await engine.start();

        expect(() =>
            engine.register(createFakeReadModel("late-model"))
        ).toThrow("Cannot register read models after engine has started");

        await engine.stop();
    });

    it("throws when registering a duplicate read model name", () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);

        engine.register(createFakeReadModel("dup"));

        expect(() => engine.register(createFakeReadModel("dup"))).toThrow(
            'Projection "dup" is already registered'
        );
    });

    it("throws when started twice", async () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        await engine.start();

        await expect(engine.start()).rejects.toThrow(
            "Projection engine has already started"
        );

        await engine.stop();
    });

    it.each([
        ["streamBatchSize", { streamBatchSize: 0 }],
        ["maxRetries", { maxRetries: 0 }],
        ["safetyIntervalMs", { safetyIntervalMs: 0 }],
        ["rebuildBatchSize", { rebuildBatchSize: 0 }],
        ["rebuildFlushConcurrency", { rebuildFlushConcurrency: 0 }],
    ] as const)("rejects invalid %s option", (name, options) => {
        const eventStore = createFakeEventStore();

        expect(
            () => new ProjectionEngine(eventStore, unitOfWork, logger, options)
        ).toThrow(
            `Projection engine option "${name}" must be a positive integer`
        );
    });

    it("does not fetch when no runners registered", async () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);

        await engine.poll();

        expect(eventStore.stream).not.toHaveBeenCalled();
    });

    it("start initializes runners and triggers background rebuild", async () => {
        const events = createStoredEvents(3);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("test-model");
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.start();

        // Background rebuild fires asynchronously — let microtasks settle
        await vi.waitFor(() => {
            const [status] = engine.getStatus();
            expect(status.mode).toBe("running");
            expect(status.health).toBe("healthy");
        });

        await engine.stop();
    });

    it("activates a rebuilding runner that is already caught up to the target position", async () => {
        const events = createStoredEvents(3);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("caught-up");
        vi.spyOn(CheckpointStore.prototype, "get").mockResolvedValue({
            projectionName: "caught-up",
            lastPosition: 3,
            version: 1,
            status: "rebuilding",
            updatedAt: new Date(),
        });
        const saveSpy = vi
            .spyOn(CheckpointStore.prototype, "save")
            .mockResolvedValue(undefined);
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.start();

        await vi.waitFor(() => {
            expect(engine.getStatus()[0]).toMatchObject({
                mode: "running",
                health: "healthy",
                lastPosition: 3,
            });
        });
        expect(readModel.reset).not.toHaveBeenCalled();
        expect(eventStore.stream).not.toHaveBeenCalled();
        expect(saveSpy).toHaveBeenCalledWith(
            "caught-up",
            3,
            1,
            expect.anything(),
            "running"
        );

        await engine.stop();
    });

    it("activates a runner whose rebuild ends before reaching the target position", async () => {
        const events = createStoredEvents(3);
        const eventStore: ReadableEventStore = {
            stream: vi.fn(async function* (afterPosition: number) {
                for (const event of events) {
                    if (event.position > afterPosition) yield event;
                }
            }),
            // Target is higher than any event the stream will ever yield, so the
            // rebuild context can never reach "completed" on its own.
            getLastPosition: vi.fn(async () => 5),
            getEventCount: vi.fn(async () => events.length),
        };
        const readModel = createFakeReadModel("short-stream");
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.start();

        await vi.waitFor(() => {
            expect(engine.getStatus()[0]).toMatchObject({
                mode: "running",
                health: "healthy",
                lastPosition: 3,
            });
        });
        expect(logger.pollError).toHaveBeenCalledWith(expect.any(Error));

        await engine.stop();
    });

    it("isolates a rebuilding runner when the startup rebuild fails", async () => {
        const eventStore: ReadableEventStore = {
            stream: vi.fn(async function* () {}),
            getLastPosition: vi.fn(async () => {
                throw new Error("event store unavailable");
            }),
            getEventCount: vi.fn(async () => 0),
        };
        const readModel = createFakeReadModel("rebuild-fail");
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.start();

        await vi.waitFor(() => {
            expect(engine.getStatus()[0]).toMatchObject({ health: "isolated" });
        });
        expect(logger.pollError).toHaveBeenCalledWith(expect.any(Error));

        await engine.stop();
    });

    it("waits for an active startup rebuild before resetting a projection", async () => {
        const events = createStoredEvents(1);
        const eventStore = createFakeEventStore(events);
        const readModel = createFakeReadModel("slow-rebuild");
        const sequence: string[] = [];
        let resetCount = 0;
        let applyCount = 0;
        let releaseFirstApply!: () => void;
        let firstApplyStarted!: () => void;
        const firstApplyStartedPromise = new Promise<void>((resolve) => {
            firstApplyStarted = resolve;
        });
        const firstApplyReleasePromise = new Promise<void>((resolve) => {
            releaseFirstApply = resolve;
        });

        vi.mocked(readModel.reset).mockImplementation(async () => {
            resetCount++;
            sequence.push(`reset-${resetCount}`);
        });
        vi.mocked(readModel.apply).mockImplementation(async () => {
            applyCount++;
            if (applyCount === 1) {
                sequence.push("startup-apply-start");
                firstApplyStarted();
                await firstApplyReleasePromise;
                sequence.push("startup-apply-end");
                return;
            }

            sequence.push("manual-reset-apply");
        });

        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            rebuildBatchSize: 1,
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.start();
        await firstApplyStartedPromise;

        const resetPromise = engine.resetProjection("slow-rebuild");
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(resetCount).toBe(1);

        releaseFirstApply();
        await resetPromise;

        expect(resetCount).toBe(2);
        expect(sequence.indexOf("startup-apply-end")).toBeLessThan(
            sequence.indexOf("reset-2")
        );
        expect(sequence).toContain("manual-reset-apply");

        await engine.stop();
    });

    it("resetProjection resets and rebuilds the target runner", async () => {
        const eventStore = createFakeEventStore();
        const readModel = createFakeReadModel("resettable");
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            safetyIntervalMs: 100_000,
        });

        engine.register(readModel);
        await engine.resetProjection("resettable");

        expect(readModel.reset).toHaveBeenCalled();

        const [status] = engine.getStatus();
        expect(status.mode).toBe("running");
        expect(status.health).toBe("healthy");
    });

    it("stop() awaits an in-flight reset rebuild", async () => {
        const events = createStoredEvents(1);
        const eventStore = createFakeEventStore(events);
        let releaseApply!: () => void;
        let applyStarted!: () => void;
        const applyStartedPromise = new Promise<void>((resolve) => {
            applyStarted = resolve;
        });
        const applyReleasePromise = new Promise<void>((resolve) => {
            releaseApply = resolve;
        });

        const readModel = createFakeReadModel("reset-stop");
        vi.mocked(readModel.apply).mockImplementation(async () => {
            applyStarted();
            await applyReleasePromise;
        });

        const engine = new ProjectionEngine(eventStore, unitOfWork, logger, {
            rebuildBatchSize: 1,
            safetyIntervalMs: 100_000,
        });
        engine.register(readModel);

        const resetPromise = engine.resetProjection("reset-stop");
        await applyStartedPromise;

        let stopResolved = false;
        const stopPromise = engine.stop().then(() => {
            stopResolved = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(stopResolved).toBe(false);

        releaseApply();
        await stopPromise;
        await resetPromise;
        expect(stopResolved).toBe(true);
    });

    it("resetProjection throws for unknown projection", async () => {
        const eventStore = createFakeEventStore();
        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);

        await expect(engine.resetProjection("nonexistent")).rejects.toThrow(
            'Projection "nonexistent" not found'
        );
    });

    it("processes all registered runners through poll", async () => {
        const events = createStoredEvents(3);
        const eventStore = createFakeEventStore(events);
        const activeModel = createFakeReadModel("active-model");
        const rebuildingModel = createFakeReadModel("rebuilding-model");

        const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
        engine.register(activeModel);
        engine.register(rebuildingModel);

        // Manually trigger rebuild state on one runner via resetProjection's resetForFreshRebuild
        // Instead, use start() which initializes (sets to rebuilding since no checkpoint)
        // and fires background rebuild. The active-model won't be active during rebuild.

        // Since both runners start as running/healthy (no initialize), poll processes both
        await engine.poll();
        expect(activeModel.apply).toHaveBeenCalledTimes(3);
        expect(rebuildingModel.apply).toHaveBeenCalledTimes(3);
    });

    describe("poll serialization", () => {
        it("skips concurrent poll when one is already in progress", async () => {
            let resolvePoll!: () => void;
            let pollStartedResolve!: () => void;
            const pollStarted = new Promise<void>((r) => {
                pollStartedResolve = r;
            });

            const eventStore: ReadableEventStore = {
                stream: vi.fn(async function* () {
                    pollStartedResolve();
                    await new Promise<void>((resolve) => {
                        resolvePoll = resolve;
                    });
                }),
                getLastPosition: vi.fn(async () => 0),
                getEventCount: vi.fn(async () => 0),
            };

            const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
            engine.register(createFakeReadModel("test-model"));

            const poll1 = engine.poll();
            await pollStarted;

            await engine.poll();

            expect(eventStore.stream).toHaveBeenCalledTimes(1);

            resolvePoll();
            await poll1;
        });

        it("allows a new poll after the previous one completes", async () => {
            const eventStore = createFakeEventStore();
            const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
            engine.register(createFakeReadModel("test-model"));

            await engine.poll();
            await engine.poll();

            expect(eventStore.stream).toHaveBeenCalledTimes(2);
        });

        it("releases the polling lock when poll throws", async () => {
            const streamMock = vi
                .fn<ReadableEventStore["stream"]>()
                .mockImplementationOnce(async function* () {
                    throw new Error("stream failed");
                })
                .mockImplementationOnce(async function* () {});

            const eventStore: ReadableEventStore = {
                stream: streamMock,
                getLastPosition: vi.fn(async () => 0),
                getEventCount: vi.fn(async () => 0),
            };

            const engine = new ProjectionEngine(eventStore, unitOfWork, logger);
            engine.register(createFakeReadModel("test-model"));

            await expect(engine.poll()).rejects.toThrow("stream failed");
            await engine.poll();

            expect(eventStore.stream).toHaveBeenCalledTimes(2);
        });
    });
});
