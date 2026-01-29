import {
    beforeAll,
    beforeEach,
    afterEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import { PostgresUnitOfWorkForTesting } from "./test";
import {
    newClient,
    useClient,
    useDatabase,
    useTableManager,
} from "@/test-fixtures";

const DATABASE = "test_hexai__uow_testing";
const TABLE = "_test";

describe("PostgresUnitOfWorkForTesting", () => {
    useDatabase(DATABASE);
    const tableManager = useTableManager(DATABASE);
    const conn = useClient(DATABASE);

    let client: pg.Client;
    let uow: PostgresUnitOfWorkForTesting;

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [{ name: "id", property: "INT" }]);
    });

    beforeEach(async () => {
        client = newClient(DATABASE);
        await client.connect();
        await client.query("BEGIN");
        uow = new PostgresUnitOfWorkForTesting(client);
    });

    afterEach(async () => {
        await client.query("ROLLBACK");
        await client.end();
    });

    async function insertRecord(c: pg.Client, id: number): Promise<void> {
        await c.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
    }

    async function runFailingTransaction(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(async (c) => {
                await fn(c);
                throw new Error("transaction failure");
            });
        } catch {
            // expected
        }
    }

    async function runFailingSavepoint(
        fn: (client: pg.Client) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(
                async (c) => {
                    await fn(c);
                    throw new Error("savepoint failure");
                },
                { propagation: Propagation.NESTED }
            );
        } catch {
            // expected
        }
    }

    describe("transaction lifecycle", () => {
        test("commits changes on successful completion", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 1);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
        });

        test("rolls back changes when error occurs", async () => {
            await runFailingTransaction(async (c) => {
                await insertRecord(c, 1);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(0);
        });

        test("allows client reuse after error", async () => {
            await runFailingTransaction(async (c) => {
                await insertRecord(c, 1);
            });

            await uow.wrap(async (c) => {
                await insertRecord(c, 2);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(2);
        });

        test("changes within uow are not visible to external connection during test", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 1);
            });

            const externalResult = await conn.query(`SELECT * FROM ${TABLE}`);
            expect(externalResult.rows).toHaveLength(0);
        });
    });

    describe("joining existing transaction", () => {
        test("rolls back entire transaction when nested EXISTING fails even if caught", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 1);

                try {
                    await uow.wrap(async () => {
                        throw new Error("nested failure");
                    });
                } catch {
                    // caught but should still abort
                }

                await insertRecord(c, 2);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(0);
        });

        test("commits all changes when nested operations succeed", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 1);

                await uow.wrap(async (nested) => {
                    await insertRecord(nested, 2);
                });
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(2);
        });
    });

    describe("nested savepoints", () => {
        test("rolls back only savepoint changes while preserving parent", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await runFailingSavepoint(async (sp) => {
                    await insertRecord(sp, 2);
                });

                await insertRecord(root, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 3]);
        });

        test("commits savepoint changes on success", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await uow.wrap(
                    async (sp) => {
                        await insertRecord(sp, 2);
                    },
                    { propagation: Propagation.NESTED }
                );

                await insertRecord(root, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3]);
        });

        test("rolls back to savepoint when nested operation fails inside savepoint", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await uow.wrap(
                    async (savepoint) => {
                        await insertRecord(savepoint, 2);

                        try {
                            await uow.wrap(async () => {
                                throw new Error("nested failure");
                            });
                        } catch {
                            // caught - savepoint should be aborted
                        }
                    },
                    { propagation: Propagation.NESTED }
                );
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(1);
        });
    });

    describe("Propagation.NEW", () => {
        test("logs warning and creates new savepoint", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await uow.wrap(
                    async (newTx) => {
                        await insertRecord(newTx, 2);
                    },
                    { propagation: Propagation.NEW }
                );
            });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Propagation.NEW is not fully supported")
            );

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2]);

            warnSpy.mockRestore();
        });
    });

    describe("sequential operations", () => {
        test("handles multiple sequential wrap calls", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 1);
            });

            await uow.wrap(async (c) => {
                await insertRecord(c, 2);
            });

            await uow.wrap(async (c) => {
                await insertRecord(c, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3]);
        });
    });

    describe("test isolation", () => {
        test("external transaction rollback cleans up all changes", async () => {
            await uow.wrap(async (c) => {
                await insertRecord(c, 100);
            });

            const beforeRollback = await client.query(`SELECT * FROM ${TABLE}`);
            expect(beforeRollback.rows).toHaveLength(1);

            await client.query("ROLLBACK");
            await client.query("BEGIN");

            const afterRollback = await client.query(`SELECT * FROM ${TABLE}`);
            expect(afterRollback.rows).toHaveLength(0);
        });
    });
});
