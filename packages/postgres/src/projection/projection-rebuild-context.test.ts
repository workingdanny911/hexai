import { describe, it, expect, vi } from "vitest";

import { ProjectionRebuildContext } from "./projection-rebuild-context.js";
import { CheckpointStore } from "./checkpoint-store.js";
import {
    createFakeLogger,
    createFakeUnitOfWork,
    createStoredEvent,
} from "./test-helpers.fixtures.js";

import type { IPostgresReadModel } from "./read-model.js";
import type { ProjectionEngineLogger } from "./types.js";
import type { StoredEvent } from "@hexaijs/core";
import type { PostgresUnitOfWork } from "../postgres-unit-of-work.js";

function createFakeReadModel(
    overrides: Partial<IPostgresReadModel> = {}
): IPostgresReadModel {
    return {
        name: "test-read-model",
        version: 1,
        canHandle: vi.fn(() => true),
        apply: vi.fn(async () => {}),
        reset: vi.fn(async () => {}),
        ...overrides,
    };
}

function createContext(
    overrides: {
        readModel?: IPostgresReadModel;
        checkpointStore?: CheckpointStore;
        unitOfWork?: PostgresUnitOfWork;
        logger?: ProjectionEngineLogger;
        batchSize?: number;
        maxRetries?: number;
        targetPosition?: number;
        totalEvents?: number;
        startPosition?: number;
    } = {}
) {
    const readModel = overrides.readModel ?? createFakeReadModel();
    const checkpointStore = overrides.checkpointStore ?? new CheckpointStore();
    const unitOfWork = overrides.unitOfWork ?? createFakeUnitOfWork();
    const logger = overrides.logger ?? createFakeLogger();

    vi.spyOn(checkpointStore, "save").mockResolvedValue(undefined);
    vi.spyOn(checkpointStore, "updateStatus").mockResolvedValue(undefined);

    const ctx = new ProjectionRebuildContext(
        readModel,
        checkpointStore,
        unitOfWork,
        logger,
        {
            batchSize: overrides.batchSize ?? 3,
            maxRetries: overrides.maxRetries ?? 3,
            targetPosition: overrides.targetPosition ?? 100,
            totalEvents: overrides.totalEvents ?? 100,
            startPosition: overrides.startPosition ?? 0,
        }
    );

    return { ctx, readModel, checkpointStore, unitOfWork, logger };
}

describe("ProjectionRebuildContext", () => {
    it("flushes full batches correctly (batchSize=3, 9 events → 3 flushes)", async () => {
        const { ctx, checkpointStore } = createContext({
            batchSize: 3,
            targetPosition: 9,
            totalEvents: 9,
        });

        const flushThunks: (() => Promise<void>)[] = [];
        for (let i = 1; i <= 9; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) flushThunks.push(thunk);
        }

        expect(flushThunks).toHaveLength(3);
        for (const thunk of flushThunks) {
            await thunk();
        }

        expect(checkpointStore.save).toHaveBeenCalledTimes(3);
    });

    it("flushes remaining events via flushRemaining (5 events, batchSize=3)", async () => {
        const { ctx, checkpointStore } = createContext({
            batchSize: 3,
            targetPosition: 5,
            totalEvents: 5,
        });

        const flushThunks: (() => Promise<void>)[] = [];
        for (let i = 1; i <= 5; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) flushThunks.push(thunk);
        }

        expect(flushThunks).toHaveLength(1);
        await flushThunks[0]();

        await ctx.flushRemaining();

        expect(checkpointStore.save).toHaveBeenCalledTimes(2);
    });

    it("completes when reaching targetPosition", async () => {
        const { ctx } = createContext({
            batchSize: 5,
            targetPosition: 5,
            totalEvents: 5,
        });

        for (let i = 1; i <= 5; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(ctx.isCompleted).toBe(true);
        expect(ctx.isActive).toBe(false);
    });

    it("ignores events after targetPosition", async () => {
        const { ctx, readModel } = createContext({
            batchSize: 3,
            targetPosition: 3,
            totalEvents: 3,
        });

        const flushThunks: (() => Promise<void>)[] = [];
        for (let i = 1; i <= 5; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) flushThunks.push(thunk);
        }

        for (const thunk of flushThunks) {
            await thunk();
        }

        expect(flushThunks).toHaveLength(1);
        expect(readModel.apply).toHaveBeenCalledTimes(3);
        expect(ctx.isCompleted).toBe(true);
    });

    it("retries batch and succeeds on retry", async () => {
        let attempt = 0;
        const readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                attempt++;
                // Fail on the very first apply call (first batch attempt), succeed thereafter
                if (attempt === 1) throw new Error("transient");
            }),
        });

        const { ctx, logger } = createContext({
            readModel,
            batchSize: 3,
            maxRetries: 3,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(logger.rebuildRetrying).toHaveBeenCalledTimes(1);
        expect(ctx.isActive).toBe(true);
        expect(ctx.currentPosition).toBe(3);
    });

    it("falls back to single-event processing when batch retries exhausted", async () => {
        let applyCallCount = 0;
        const readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                applyCallCount++;
                // Batch has 3 events; each batch attempt fails on first event.
                // 3 batch retries = 3 apply calls. After that, single fallback succeeds.
                if (applyCallCount <= 3) throw new Error("batch fail");
            }),
        });

        const { ctx, logger, checkpointStore } = createContext({
            readModel,
            batchSize: 3,
            maxRetries: 3,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(logger.singleFallbackStarted).toHaveBeenCalledWith(
            "test-read-model",
            3
        );
        expect(checkpointStore.save).toHaveBeenCalled();
        expect(ctx.isActive).toBe(true);
    });

    it("isolates when single-event processing also exhausts retries", async () => {
        const readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("permanent failure");
            }),
        });

        const { ctx, logger, checkpointStore } = createContext({
            readModel,
            batchSize: 3,
            maxRetries: 2,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(ctx.isIsolated).toBe(true);
        expect(ctx.isActive).toBe(false);
        expect(checkpointStore.updateStatus).toHaveBeenCalledWith(
            "test-read-model",
            "isolated",
            expect.anything()
        );
        expect(logger.runnerIsolated).toHaveBeenCalledWith(
            "test-read-model",
            2,
            expect.any(Error)
        );
    });

    it("returns undefined from accept() when isolated", async () => {
        const readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("permanent");
            }),
        });

        const { ctx } = createContext({
            readModel,
            batchSize: 3,
            maxRetries: 1,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(ctx.isIsolated).toBe(true);

        const result = ctx.accept(createStoredEvent(4));
        expect(result).toBeUndefined();
    });

    it("reports progress accurately after each batch flush", async () => {
        const { ctx, logger } = createContext({
            batchSize: 3,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 6; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(ctx.getProgress()).toEqual({ processed: 6, total: 9 });
        expect(logger.rebuildProgress).toHaveBeenCalledWith(
            "test-read-model",
            3,
            9,
            3
        );
        expect(logger.rebuildProgress).toHaveBeenCalledWith(
            "test-read-model",
            6,
            9,
            6
        );
    });

    it("advances position for canHandle=false events without calling apply", async () => {
        const readModel = createFakeReadModel({
            canHandle: vi.fn(() => false),
        });

        const { ctx, checkpointStore } = createContext({
            readModel,
            batchSize: 3,
            targetPosition: 3,
            totalEvents: 3,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(readModel.apply).not.toHaveBeenCalled();
        expect(checkpointStore.save).toHaveBeenCalledWith(
            "test-read-model",
            3,
            1,
            expect.anything(),
            "rebuilding"
        );
        expect(ctx.currentPosition).toBe(3);
    });

    it("skips already-committed events in single fallback", async () => {
        // startPosition=2 means events at position ≤ 2 are already committed.
        // Batch will contain events [3, 4, 5]. Batch retries fail → single fallback.
        // In single fallback, event 3 succeeds (pos→3). Now manually verify
        // that only events with position > currentPosition are applied.
        let applyCallCount = 0;
        const appliedPositions: number[] = [];
        const readModel = createFakeReadModel({
            apply: vi.fn(async (storedEvent: StoredEvent) => {
                applyCallCount++;
                // Batch retries: fail first 3 calls (one per retry attempt, failing on event 3)
                if (applyCallCount <= 3) throw new Error("batch fail");
                // Single fallback: track which events are applied
                appliedPositions.push(storedEvent.position);
            }),
        });

        const { ctx, checkpointStore } = createContext({
            readModel,
            batchSize: 3,
            maxRetries: 3,
            targetPosition: 9,
            totalEvents: 9,
            startPosition: 2,
        });

        // Events 1 and 2 are skipped by accept() (position <= startPosition)
        expect(ctx.accept(createStoredEvent(1))).toBeUndefined();
        expect(ctx.accept(createStoredEvent(2))).toBeUndefined();

        // Events 3, 4, 5 fill the batch
        const thunks: (() => Promise<void>)[] = [];
        for (let i = 3; i <= 5; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) thunks.push(thunk);
        }

        expect(thunks).toHaveLength(1);
        await thunks[0]();

        // Batch retries exhausted → single fallback processed events 3, 4, 5
        expect(checkpointStore.save).toHaveBeenCalledTimes(3);
        expect(appliedPositions).toEqual([3, 4, 5]);
        expect(ctx.currentPosition).toBe(5);
    });

    it("rejects duplicate position events within same batch", async () => {
        const { ctx, readModel } = createContext({
            batchSize: 5,
            targetPosition: 10,
            totalEvents: 10,
        });

        ctx.accept(createStoredEvent(1, "first.event"));
        const thunk = ctx.accept(createStoredEvent(1, "duplicate.event"));

        expect(thunk).toBeUndefined();
        expect(ctx.getProgress().processed).toBe(0);

        await ctx.flushRemaining();

        expect(readModel.apply).toHaveBeenCalledTimes(1);
        expect(ctx.currentPosition).toBe(1);
    });

    it("saves checkpoint with rebuilding status", async () => {
        const { ctx, checkpointStore } = createContext({
            batchSize: 3,
            targetPosition: 9,
            totalEvents: 9,
        });

        for (let i = 1; i <= 3; i++) {
            const thunk = ctx.accept(createStoredEvent(i));
            if (thunk) await thunk();
        }

        expect(checkpointStore.save).toHaveBeenCalledWith(
            "test-read-model",
            3,
            1,
            expect.anything(),
            "rebuilding"
        );
    });
});
