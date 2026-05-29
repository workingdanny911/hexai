import { describe, expect, it, vi } from "vitest";

import {
    hasProjectionIntegrationDatabaseUrl,
    useProjectionIntegrationScenario,
} from "./projection-integration.fixtures.js";

if (!hasProjectionIntegrationDatabaseUrl()) {
    describe.skip("Postgres projection integration", () => {
        it("requires HEXAI_DB_URL", () => {});
    });
} else {
    describe("Postgres projection integration", () => {
        const scenario = useProjectionIntegrationScenario();

        it("runs hexai and projection migrations", async () => {
            await expect(
                scenario.tablesExist(
                    "hexai__events",
                    "projection__checkpoints"
                )
            ).resolves.toEqual({
                hexai__events: true,
                projection__checkpoints: true,
            });
        });

        it("round-trips checkpoint state through the real database", async () => {
            const projectionName = "checkpoint-roundtrip";

            await scenario.saveCheckpoint({
                name: projectionName,
                position: 7,
                version: 3,
                status: "running",
            });

            await expect(
                scenario.readCheckpoint(projectionName)
            ).resolves.toMatchObject({
                projectionName,
                lastPosition: 7,
                version: 3,
                status: "running",
            });

            await scenario.markCheckpointIsolated(projectionName);

            await expect(
                scenario.readCheckpoint(projectionName)
            ).resolves.toMatchObject({
                projectionName,
                lastPosition: 7,
                version: 3,
                status: "isolated",
            });

            await scenario.resetCheckpoint(projectionName);

            await expect(
                scenario.readCheckpoint(projectionName)
            ).resolves.toBeNull();
        });

        it("polls stored events into a read model and checkpoints the full stream", async () => {
            const projection = await scenario.projectEvents(
                {
                    type: "projection.handled",
                    payload: { value: "first" },
                },
                {
                    type: "projection.unhandled",
                    payload: { value: "ignored" },
                },
                {
                    type: "projection.handled",
                    payload: { value: "last" },
                }
            );

            expect(projection.rows).toEqual([
                {
                    id: 1,
                    eventType: "projection.handled",
                    eventPosition: 1,
                    payload: { value: "first" },
                },
                {
                    id: 2,
                    eventType: "projection.handled",
                    eventPosition: 3,
                    payload: { value: "last" },
                },
            ]);
            expect(projection.checkpoint).toMatchObject({
                projectionName: "projection-integration-read-model",
                lastPosition: 3,
                version: 1,
                status: "running",
            });
        });

        it("rolls back the read model write and checkpoint when apply throws", async () => {
            await scenario.ensureReadModelTable();
            await scenario.storeEvents(
                { type: "projection.handled", payload: { value: "good" } },
                { type: "projection.bad", payload: { value: "explode" } }
            );
            const engine = scenario.createEngine(
                scenario.createReadModel({
                    handledTypes: ["projection.handled", "projection.bad"],
                    failOnType: "projection.bad",
                    insertBeforeFail: true,
                }),
                { maxRetries: 1 }
            );

            await engine.poll();

            // The good event (position 1) is applied + checkpointed. The failing
            // event (position 2) inserts a row then throws in the same apply, so
            // the engine's transaction rolls it back: no row persists and the
            // checkpoint never advances past 1.
            expect(await scenario.readProjectionRows()).toEqual([
                {
                    id: 1,
                    eventType: "projection.handled",
                    eventPosition: 1,
                    payload: { value: "good" },
                },
            ]);
            expect(await scenario.readCheckpoint()).toMatchObject({
                lastPosition: 1,
                status: "isolated",
            });
        });

        it("rebuilds a fresh read model from the stored stream on start", async () => {
            await scenario.ensureReadModelTable();
            await scenario.storeEvents(
                { type: "projection.handled", payload: { value: "first" } },
                { type: "projection.unhandled", payload: { value: "ignored" } },
                { type: "projection.handled", payload: { value: "last" } }
            );
            const engine = scenario.createEngine(scenario.createReadModel());

            await engine.start();
            try {
                await vi.waitFor(() => {
                    expect(engine.getStatus()[0]).toMatchObject({
                        mode: "running",
                        health: "healthy",
                        lastPosition: 3,
                    });
                });
            } finally {
                await engine.stop();
            }

            expect(await scenario.readProjectionRows()).toEqual([
                {
                    id: 1,
                    eventType: "projection.handled",
                    eventPosition: 1,
                    payload: { value: "first" },
                },
                {
                    id: 2,
                    eventType: "projection.handled",
                    eventPosition: 3,
                    payload: { value: "last" },
                },
            ]);
            expect(await scenario.readCheckpoint()).toMatchObject({
                lastPosition: 3,
                version: 1,
                status: "running",
            });
        });

        it("persists isolated status after exhausting retries on a poison event", async () => {
            await scenario.ensureReadModelTable();
            await scenario.saveCheckpoint({
                name: scenario.defaultReadModelName,
                position: 0,
                version: 1,
                status: "running",
            });
            await scenario.storeEvents({ type: "projection.handled" });
            const engine = scenario.createEngine(
                scenario.createReadModel({ failOnType: "projection.handled" }),
                { maxRetries: 2 }
            );

            await engine.poll(); // attempt 1 → retrying
            await engine.poll(); // attempt 2 → isolated

            expect(await scenario.readCheckpoint()).toMatchObject({
                status: "isolated",
                lastPosition: 0,
                version: 1,
            });
        });

        it("persists isolated status for a poison event without a prior checkpoint", async () => {
            await scenario.ensureReadModelTable();
            await scenario.storeEvents({ type: "projection.handled" });
            const engine = scenario.createEngine(
                scenario.createReadModel({ failOnType: "projection.handled" }),
                { maxRetries: 1 }
            );

            await engine.poll();

            // No start()/initialize() ran, so no checkpoint row existed. The
            // isolation must still be durably upserted (not a silent no-op).
            expect(await scenario.readCheckpoint()).toMatchObject({
                status: "isolated",
                lastPosition: 0,
                version: 1,
            });
        });

        it("commits projection writes independently of an ambient transaction", async () => {
            await scenario.ensureReadModelTable();
            await scenario.storeEvents({
                type: "projection.handled",
                payload: { value: "x" },
            });
            const engine = scenario.createEngine(scenario.createReadModel());

            // poll() runs inside an outer transaction that rolls back. The engine
            // uses Propagation.NEW, so its apply + checkpoint commit independently
            // and survive the outer rollback — the in-memory position can never
            // diverge from the persisted state.
            await scenario.unitOfWork
                .scope(async () => {
                    await engine.poll();
                    throw new Error("outer rollback");
                })
                .catch(() => {});

            expect(await scenario.readProjectionRows()).toHaveLength(1);
            expect(await scenario.readCheckpoint()).toMatchObject({
                lastPosition: 1,
                status: "running",
            });
        });

        it("resets the read model and checkpoint when the version changes", async () => {
            await scenario.ensureReadModelTable();
            await scenario.storeEvents({
                type: "projection.handled",
                payload: { value: "v1" },
            });

            const v1 = scenario.createEngine(
                scenario.createReadModel({ version: 1 })
            );
            await v1.poll();
            expect(await scenario.readCheckpoint()).toMatchObject({
                version: 1,
                lastPosition: 1,
            });
            expect(await scenario.readProjectionRows()).toHaveLength(1);

            // Version 2 start: initialize() sees the mismatch, resets read model
            // + checkpoint, and rebuilds from scratch.
            const v2 = scenario.createEngine(
                scenario.createReadModel({ version: 2 })
            );
            await v2.start();
            try {
                await vi.waitFor(() => {
                    expect(v2.getStatus()[0]).toMatchObject({
                        mode: "running",
                        lastPosition: 1,
                    });
                });
            } finally {
                await v2.stop();
            }

            expect(await scenario.readCheckpoint()).toMatchObject({
                version: 2,
                lastPosition: 1,
                status: "running",
            });
            // reset() truncated the v1 row; rebuild re-applied exactly one row.
            expect(await scenario.readProjectionRows()).toHaveLength(1);
        });
    });
}
