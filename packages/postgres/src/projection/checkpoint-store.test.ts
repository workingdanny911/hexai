import { describe, it, expect, vi, beforeEach } from "vitest";

import { CheckpointStore } from "./checkpoint-store.js";

import type { CheckpointStatus } from "./types.js";

function createMockClient() {
    const rows: Record<string, any[]> = {};

    return {
        query: vi.fn(async (sql: string, params?: any[]) => {
            const text = sql.trim();

            if (text.startsWith("SELECT")) {
                const name = params?.[0];
                return { rows: rows[name] ?? [] };
            }

            if (text.startsWith("INSERT")) {
                const [name, position, version, status] = params ?? [];
                rows[name] = [
                    {
                        projection_name: name,
                        last_position: String(position),
                        version,
                        status: status as CheckpointStatus,
                        updated_at: new Date(),
                    },
                ];
                return { rows: [] };
            }

            if (text.startsWith("UPDATE")) {
                const [status, name] = params ?? [];
                if (rows[name]?.[0]) {
                    rows[name][0].status = status;
                }
                return { rows: [] };
            }

            if (text.startsWith("DELETE")) {
                const name = params?.[0];
                delete rows[name];
                return { rows: [] };
            }

            return { rows: [] };
        }),
    };
}

describe("CheckpointStore", () => {
    let store: CheckpointStore;
    let client: ReturnType<typeof createMockClient>;

    beforeEach(() => {
        store = new CheckpointStore();
        client = createMockClient();
    });

    it("returns null for missing checkpoint", async () => {
        const result = await store.get("nonexistent", client as any);
        expect(result).toBeNull();
    });

    it("roundtrips save and get", async () => {
        await store.save("test-projection", 42, 1, client as any);
        const result = await store.get("test-projection", client as any);

        expect(result).not.toBeNull();
        expect(result!.projectionName).toBe("test-projection");
        expect(result!.lastPosition).toBe(42);
        expect(result!.version).toBe(1);
        expect(result!.status).toBe("running");
    });

    it("upserts on multiple saves for the same name", async () => {
        await store.save("test-projection", 10, 1, client as any);
        await store.save("test-projection", 50, 2, client as any);

        const result = await store.get("test-projection", client as any);
        expect(result!.lastPosition).toBe(50);
        expect(result!.version).toBe(2);
    });

    it("updates status", async () => {
        await store.save("test-projection", 10, 1, client as any);
        await store.updateStatus("test-projection", "isolated", client as any);

        const result = await store.get("test-projection", client as any);
        expect(result!.status).toBe("isolated");
    });

    it("deletes checkpoint on reset", async () => {
        await store.save("test-projection", 10, 1, client as any);
        await store.reset("test-projection", client as any);

        const result = await store.get("test-projection", client as any);
        expect(result).toBeNull();
    });

    describe("getForUpdate", () => {
        it("returns null for missing checkpoint", async () => {
            const result = await store.getForUpdate(
                "nonexistent",
                client as any
            );
            expect(result).toBeNull();
        });

        it("returns the same mapping as get", async () => {
            await store.save("test-projection", 42, 1, client as any);

            const viaGet = await store.get("test-projection", client as any);
            const viaForUpdate = await store.getForUpdate(
                "test-projection",
                client as any
            );

            expect(viaForUpdate).toEqual(viaGet);
            expect(viaForUpdate!.lastPosition).toBe(42);
            expect(viaForUpdate!.status).toBe("running");
        });

        it("issues a SELECT ... FOR UPDATE query", async () => {
            await store.getForUpdate("test-projection", client as any);

            const forUpdateCall = client.query.mock.calls.find(([sql]) =>
                /FOR UPDATE/i.test(sql as string)
            );
            expect(forUpdateCall).toBeDefined();
            expect(forUpdateCall![1]).toEqual(["test-projection"]);
        });
    });

    it("saves with rebuilding status", async () => {
        await store.save("test-projection", 10, 1, client as any, "rebuilding");
        const result = await store.get("test-projection", client as any);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("rebuilding");
    });

    it("defaults to running status", async () => {
        await store.save("test-projection", 10, 1, client as any);
        const result = await store.get("test-projection", client as any);

        expect(result).not.toBeNull();
        expect(result!.status).toBe("running");
    });
});
