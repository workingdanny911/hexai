import { describe, it, expect, vi, beforeEach } from "vitest";

import { ProjectionRunner } from "./projection-runner.js";
import { CheckpointStore } from "./checkpoint-store.js";
import {
    createFakeLogger,
    createFakeUnitOfWork,
    createStoredEvent,
} from "./test-helpers.fixtures.js";

import type { IPostgresReadModel } from "./read-model.js";
import type { CheckpointStatus, ProjectionEngineLogger } from "./types.js";
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

describe("ProjectionRunner", () => {
    let readModel: IPostgresReadModel;
    let checkpointStore: CheckpointStore;
    let unitOfWork: PostgresUnitOfWork;
    let logger: ProjectionEngineLogger;

    beforeEach(() => {
        readModel = createFakeReadModel();
        checkpointStore = new CheckpointStore();
        vi.spyOn(checkpointStore, "save").mockResolvedValue(undefined);
        unitOfWork = createFakeUnitOfWork();
        logger = createFakeLogger();
    });

    it("calls apply for handled events", async () => {
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger
        );
        const storedEvent = createStoredEvent(1);

        await runner.processEvent(storedEvent);

        expect(readModel.canHandle).toHaveBeenCalledWith(storedEvent);
        expect(readModel.apply).toHaveBeenCalledWith(
            storedEvent,
            expect.anything()
        );
        expect(checkpointStore.save).toHaveBeenCalled();
        expect(runner.currentPosition).toBe(1);
    });

    it("skips apply for unhandled events but still advances checkpoint", async () => {
        readModel = createFakeReadModel({ canHandle: vi.fn(() => false) });
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger
        );

        await runner.processEvent(createStoredEvent(1));

        expect(readModel.apply).not.toHaveBeenCalled();
        expect(checkpointStore.save).toHaveBeenCalled();
        expect(runner.currentPosition).toBe(1);
    });

    it("transitions to retrying on first failure", async () => {
        readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("apply failed");
            }),
        });
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger
        );

        await runner.processEvent(createStoredEvent(1));

        expect(runner.getStatus().health).toBe("retrying");
        expect(runner.getStatus().retryCount).toBe(1);
        expect(logger.runnerRetrying).toHaveBeenCalledWith(
            "test-read-model",
            1,
            3,
            expect.any(Error)
        );
    });

    it("becomes isolated after max retries and persists status", async () => {
        readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("apply failed");
            }),
        });
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger,
            2
        );

        await runner.processEvent(createStoredEvent(1));
        await runner.processEvent(createStoredEvent(1));

        expect(runner.getStatus().health).toBe("isolated");
        expect(runner.isIsolated).toBe(true);
        // persistIsolation upserts the checkpoint with status "isolated" so the
        // isolation survives even without a prior checkpoint row.
        expect(checkpointStore.save).toHaveBeenCalledWith(
            "test-read-model",
            expect.any(Number),
            1,
            expect.anything(),
            "isolated"
        );
        expect(logger.runnerIsolated).toHaveBeenCalledWith(
            "test-read-model",
            2,
            expect.any(Error)
        );
    });

    it("logs when persisting isolated status fails but keeps in-memory isolation", async () => {
        readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("apply failed");
            }),
        });
        vi.mocked(checkpointStore.save).mockRejectedValue(
            new Error("checkpoint write failed")
        );
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger,
            1
        );

        await runner.processEvent(createStoredEvent(1));

        expect(runner.isIsolated).toBe(true);
        expect(logger.pollError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("recovers from retrying to healthy after successful process", async () => {
        let shouldFail = true;
        readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                if (shouldFail) throw new Error("fail");
            }),
        });
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger
        );

        await runner.processEvent(createStoredEvent(1));
        expect(runner.getStatus().health).toBe("retrying");

        shouldFail = false;
        await runner.processEvent(createStoredEvent(2));
        expect(runner.getStatus().mode).toBe("running");
        expect(runner.getStatus().health).toBe("healthy");
        expect(runner.getStatus().retryCount).toBe(0);
    });

    it("does not process events when isolated", async () => {
        readModel = createFakeReadModel({
            apply: vi.fn(async () => {
                throw new Error("fail");
            }),
        });
        vi.spyOn(checkpointStore, "updateStatus").mockResolvedValue(undefined);
        const runner = new ProjectionRunner(
            readModel,
            checkpointStore,
            unitOfWork,
            logger,
            1
        );

        await runner.processEvent(createStoredEvent(1));
        expect(runner.isIsolated).toBe(true);

        vi.mocked(readModel.apply).mockReset();
        await runner.processEvent(createStoredEvent(2));
        expect(readModel.apply).not.toHaveBeenCalled();
    });

    describe("transactional dedup guard", () => {
        function checkpointAt(
            lastPosition: number,
            status: CheckpointStatus = "running"
        ) {
            return {
                projectionName: "test-read-model",
                lastPosition,
                version: 1,
                status,
                updatedAt: new Date(),
            };
        }

        it("skips apply and save when checkpoint already covers the event position", async () => {
            vi.spyOn(checkpointStore, "getForUpdate").mockResolvedValue(
                checkpointAt(5)
            );
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            const result = await runner.processEvent(createStoredEvent(5));

            expect(result).toBe("processed");
            expect(readModel.apply).not.toHaveBeenCalled();
            expect(checkpointStore.save).not.toHaveBeenCalled();
            expect(runner.currentPosition).toBe(5);
        });

        it("advances in-memory position to the committed checkpoint when skipping", async () => {
            vi.spyOn(checkpointStore, "getForUpdate").mockResolvedValue(
                checkpointAt(8)
            );
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.processEvent(createStoredEvent(3));

            expect(runner.currentPosition).toBe(8);
        });

        it("applies and saves when checkpoint is behind the event position", async () => {
            vi.spyOn(checkpointStore, "getForUpdate").mockResolvedValue(
                checkpointAt(4)
            );
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            const result = await runner.processEvent(createStoredEvent(5));

            expect(result).toBe("processed");
            expect(readModel.apply).toHaveBeenCalled();
            expect(checkpointStore.save).toHaveBeenCalledWith(
                "test-read-model",
                5,
                1,
                expect.anything()
            );
            expect(runner.currentPosition).toBe(5);
        });

        it("treats a missing checkpoint as committed=0 and applies the event", async () => {
            vi.spyOn(checkpointStore, "getForUpdate").mockResolvedValue(null);
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.processEvent(createStoredEvent(1));

            expect(readModel.apply).toHaveBeenCalled();
            expect(runner.currentPosition).toBe(1);
        });

        it("recovers to healthy on retry after a commit-ambiguous failure without re-applying", async () => {
            const getForUpdate = vi
                .spyOn(checkpointStore, "getForUpdate")
                .mockResolvedValueOnce(checkpointAt(0))
                .mockResolvedValue(checkpointAt(1));
            // First attempt: apply runs but the surrounding commit is reported as
            // failed even though it landed server-side. Subsequent attempts see the
            // committed checkpoint and must not re-apply.
            const apply = vi
                .fn(async () => {})
                .mockRejectedValueOnce(new Error("commit ambiguity"));
            readModel = createFakeReadModel({ apply });
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            const first = await runner.processEvent(createStoredEvent(1));
            expect(first).toBe("retrying");
            expect(runner.getStatus().health).toBe("retrying");

            const second = await runner.processEvent(createStoredEvent(1));

            expect(second).toBe("processed");
            expect(apply).toHaveBeenCalledTimes(1);
            expect(runner.getStatus().health).toBe("healthy");
            expect(runner.getStatus().retryCount).toBe(0);
            expect(runner.currentPosition).toBe(1);
            expect(getForUpdate).toHaveBeenCalledTimes(2);
        });
    });

    describe("initialize", () => {
        it("resets when no checkpoint exists", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue(null);
            vi.spyOn(checkpointStore, "reset").mockResolvedValue(undefined);
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.initialize();

            expect(readModel.reset).toHaveBeenCalled();
            expect(checkpointStore.reset).toHaveBeenCalled();
            expect(checkpointStore.save).toHaveBeenCalledWith(
                "test-read-model",
                0,
                1,
                expect.anything(),
                "rebuilding"
            );
            expect(runner.currentPosition).toBe(0);
            expect(runner.getStatus().mode).toBe("rebuilding");
            expect(runner.getStatus().health).toBe("healthy");
        });

        it("resets when version mismatches", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue({
                projectionName: "test-read-model",
                lastPosition: 50,
                version: 99,
                status: "running",
                updatedAt: new Date(),
            });
            vi.spyOn(checkpointStore, "reset").mockResolvedValue(undefined);
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.initialize();

            expect(readModel.reset).toHaveBeenCalled();
            expect(runner.currentPosition).toBe(0);
            expect(runner.getStatus().mode).toBe("rebuilding");
        });

        it("resumes from checkpoint when version matches", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue({
                projectionName: "test-read-model",
                lastPosition: 42,
                version: 1,
                status: "running",
                updatedAt: new Date(),
            });
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.initialize();

            expect(readModel.reset).not.toHaveBeenCalled();
            expect(runner.currentPosition).toBe(42);
            expect(runner.getStatus().mode).toBe("running");
            expect(runner.getStatus().health).toBe("healthy");
        });

        it("restores isolated status from checkpoint", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue({
                projectionName: "test-read-model",
                lastPosition: 10,
                version: 1,
                status: "isolated",
                updatedAt: new Date(),
            });
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.initialize();

            expect(runner.getStatus().health).toBe("isolated");
            expect(runner.currentPosition).toBe(10);
        });

        it("resumes rebuild from checkpoint with status=rebuilding", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue({
                projectionName: "test-read-model",
                lastPosition: 40,
                version: 1,
                status: "rebuilding",
                updatedAt: new Date(),
            });
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.initialize();

            expect(readModel.reset).not.toHaveBeenCalled();
            expect(runner.currentPosition).toBe(40);
            expect(runner.getStatus().mode).toBe("rebuilding");
            expect(runner.getStatus().health).toBe("healthy");
        });

        it("throws when checkpoint status is unknown", async () => {
            vi.spyOn(checkpointStore, "get").mockResolvedValue({
                projectionName: "test-read-model",
                lastPosition: 10,
                version: 1,
                status: "misspelled" as any,
                updatedAt: new Date(),
            });
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await expect(runner.initialize()).rejects.toThrow(
                'Projection "test-read-model" has unknown checkpoint status "misspelled"'
            );
        });
    });

    describe("resetForFreshRebuild", () => {
        it("resets readModel and checkpoint, saves initial rebuilding checkpoint", async () => {
            vi.spyOn(checkpointStore, "reset").mockResolvedValue(undefined);
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );
            await runner.processEvent(createStoredEvent(50));
            expect(runner.currentPosition).toBe(50);

            await runner.resetForFreshRebuild();

            expect(readModel.reset).toHaveBeenCalled();
            expect(checkpointStore.reset).toHaveBeenCalled();
            expect(checkpointStore.save).toHaveBeenCalledWith(
                "test-read-model",
                0,
                1,
                expect.anything(),
                "rebuilding"
            );
            expect(runner.currentPosition).toBe(0);
            expect(runner.getStatus().mode).toBe("rebuilding");
            expect(runner.getStatus().health).toBe("healthy");
        });

        it("prevents concurrent resets", async () => {
            let resetCount = 0;
            readModel = createFakeReadModel({
                reset: vi.fn(async () => {
                    resetCount++;
                }),
            });
            vi.spyOn(checkpointStore, "reset").mockResolvedValue(undefined);
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await Promise.all([
                runner.resetForFreshRebuild(),
                runner.resetForFreshRebuild(),
            ]);

            expect(resetCount).toBe(1);
        });
    });

    describe("lifecycle methods", () => {
        it("activateAfterRebuild transitions to running mode and persists checkpoint", async () => {
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            await runner.activateAfterRebuild(50);

            expect(runner.getStatus().mode).toBe("running");
            expect(runner.getStatus().health).toBe("healthy");
            expect(runner.currentPosition).toBe(50);
            expect(checkpointStore.save).toHaveBeenCalledWith(
                "test-read-model",
                50,
                1,
                expect.anything(),
                "running"
            );
        });

        it("markIsolatedFromRebuild transitions to isolated health", () => {
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );

            runner.markIsolatedFromRebuild();

            expect(runner.getStatus().mode).toBe("running");
            expect(runner.getStatus().health).toBe("isolated");
        });

        it("isActive returns true only when running and not isolated", async () => {
            const runner = new ProjectionRunner(
                readModel,
                checkpointStore,
                unitOfWork,
                logger
            );
            expect(runner.isActive).toBe(true);

            runner.markIsolatedFromRebuild();
            expect(runner.isActive).toBe(false);

            await runner.activateAfterRebuild(10);
            expect(runner.isActive).toBe(true);

            vi.spyOn(checkpointStore, "reset").mockResolvedValue(undefined);
            await runner.resetForFreshRebuild();
            expect(runner.isActive).toBe(false);
        });
    });
});
