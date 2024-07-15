import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as pg from "pg";
import _ from "lodash";

import {
    IsolationLevel,
    Propagation,
    UnitOfWorkAbortedError,
} from "@hexai/core";
import { DB_URL } from "./config";
import { PostgresUnitOfWork } from "./postgres-unit-of-work";
import { DatabaseManager, replaceDatabaseName, TableManager } from "./helpers";

const DATABASE = "test_hexai__uow";
const TABLE = "_test";
const URL = replaceDatabaseName(DATABASE, DB_URL);

describe("PostgreSQL unit of work", () => {
    const dbManager = new DatabaseManager(replaceDatabaseName("postgres", URL));
    const conn = new pg.Client(URL);
    const tableManager = new TableManager(conn);
    const uow = new PostgresUnitOfWork(
        () => new pg.Client(URL),
        (client) => client.end()
    );

    beforeAll(async () => {
        await dbManager.createDatabase(DATABASE);
        await tableManager.createTable(TABLE, [
            {
                name: "id",
                property: "INT",
            },
        ]);

        return async () => {
            await tableManager.close();

            await dbManager.dropDatabase(DATABASE);
            await dbManager.close();
        };
    });

    beforeEach(async () => {
        await tableManager.truncateTable(TABLE);
    });

    test("getClient() outside of uow throws error", async () => {
        expect(() => uow.getClient()).toThrowError(/.*not started.*/);
    });

    test("client passed as argument and client from .getClient() shares the same transaction", async () => {
        await uow.wrap(async (client) => {
            const txId = await getTxid(client);
            await expect(getTxid(uow.getClient())).resolves.toBe(txId);
        });
    });

    test("committing", async () => {
        await uow.wrap((c) => insert(c, 1));

        expect(await exists(conn, 1)).toBe(true);
    });

    test("rolling back", async () => {
        await expect(
            uow.wrap(async (client) => {
                await insert(client, 1);

                throw new Error("rollback");
            })
        ).rejects.toThrowError("rollback");

        expect(await exists(conn, 1)).toBe(false);
    });

    test("using existing transaction - same txid", async () => {
        const txids = new Set();

        await uow.wrap(async (client) => {
            txids.add(await getTxid(client));

            await uow.wrap(async (client) => txids.add(await getTxid(client)));
        });

        expect(txids.size).toBe(1);
    });

    test("using existing transaction - rollback", async () => {
        await uow.wrap(async (c1) => {
            await insert(c1, 1);

            try {
                await uow.wrap(
                    () => {
                        throw new Error("rollback");
                    },
                    {
                        propagation: Propagation.EXISTING,
                    }
                );
            } catch {}
        });

        expect(await count(conn)).toBe(0);
    });

    test("using existing transaction - cannot use client after rollback", async () => {
        await uow.wrap(async (c1) => {
            try {
                await uow.wrap(
                    () => {
                        throw new Error("rollback");
                    },
                    {
                        propagation: Propagation.EXISTING,
                    }
                );
            } catch {}

            await expect(insert(c1, 1)).rejects.toThrowError(
                UnitOfWorkAbortedError
            );
        });
    });

    test("using existing transaction - commit", async () => {
        await uow.wrap(async (c1) => {
            await insert(c1, 1);

            await uow.wrap((c2) => insert(c2, 2));
        });

        expect(await count(conn)).toBe(2);
    });

    test("forcing new transaction", async () => {
        const number = 5;
        const txids = new Set();
        function newUow() {
            return uow.wrap(
                async (client) => {
                    txids.add(await getTxid(client));
                },
                { propagation: Propagation.NEW }
            );
        }

        await uow.wrap(() => Promise.all(_.times(number, newUow)));

        expect(new Set(txids).size).toBe(number);
    });

    test("nested transactions", async () => {
        const txids = new Set();
        async function track(client: pg.Client, id: number) {
            txids.add(await getTxid(client));
            await insert(client, id);
        }

        await uow.wrap(async (c1) => {
            await track(c1, 1);

            try {
                await uow.wrap(
                    async (c2) => {
                        await track(c2, 2);

                        throw new Error("rollback");
                    },
                    { propagation: Propagation.NESTED }
                );
            } catch {}

            await track(c1, 3);

            await uow.wrap(async (c4) => track(c4, 4), {
                propagation: Propagation.NESTED,
            });
        });

        expect(txids.size).toBe(1);

        expect(await exists(conn, 1)).toBe(true);
        expect(await exists(conn, 2)).toBe(false);
        expect(await exists(conn, 3)).toBe(true);
        expect(await exists(conn, 4)).toBe(true);
    });

    test.each([
        IsolationLevel.READ_COMMITTED,
        IsolationLevel.REPEATABLE_READ,
        IsolationLevel.SERIALIZABLE,
    ])("isolation level", async (isolationLevel) => {
        await uow.wrap(
            async (client) => {
                const result = await client.query(
                    "SHOW TRANSACTION ISOLATION LEVEL"
                );

                expect(result.rows[0].transaction_isolation).toBe(
                    isolationLevel
                );
            },
            { isolationLevel }
        );
    });

    test("anniehilating client", async () => {
        let client!: pg.Client;

        await uow.wrap(async () => {
            client = uow.getClient();
        });

        await expect(getTxid(client)).rejects.toThrowError(/.*closed.*/);
    });
});

async function insert(client: pg.Client, id: number): Promise<void> {
    await client.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
}

async function exists(client: pg.Client, id: number): Promise<boolean> {
    const result = await client.query(
        `SELECT COUNT(*) FROM ${TABLE} WHERE id = $1;`,
        [id]
    );
    return result.rows[0].count > 0;
}

async function count(client: pg.Client): Promise<number> {
    const result = await client.query(`SELECT COUNT(*) FROM ${TABLE};`);
    return parseInt(result.rows[0].count);
}

async function getTxid(client: pg.Client): Promise<string> {
    const result = await client.query(`SELECT txid_current();`);
    return result.rows[0].txid_current;
}
