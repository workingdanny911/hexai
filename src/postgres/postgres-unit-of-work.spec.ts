import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import * as pg from "pg";

import {
    IsolationLevel,
    Propagation,
    UnitOfWorkAbortedError,
} from "Hexai/infra";
import { postgresUnitOfWork } from "./postgres-unit-of-work";
import _ from "lodash";

const DB_URL =
    process.env.POSTGRES_URL ||
    "postgresql://postgres:postgres@localhost:5432/postgres";

async function insert(client: pg.Client, id: number): Promise<void> {
    await client.query(`INSERT INTO _test VALUES ($1);`, [id]);
}

async function exists(client: pg.Client, id: number): Promise<boolean> {
    const result = await client.query(
        `SELECT COUNT(*) FROM _test WHERE id = $1;`,
        [id]
    );
    return result.rows[0].count > 0;
}

async function count(client: pg.Client): Promise<number> {
    const result = await client.query(`SELECT COUNT(*) FROM _test;`);
    return parseInt(result.rows[0].count);
}

async function getTxid(client: pg.Client): Promise<string> {
    const result = await client.query(`SELECT txid_current();`);
    return result.rows[0].txid_current;
}

function getDatabaseName(url: string): string {
    return url.match(/([\w_])+$/)![0];
}

function replaceDatabaseName(url: string, database: string): string {
    return url.replace(/([\w_])+$/, database);
}

describe("PostgreSQL unit of work", () => {
    const privilegedConn = new pg.Client({
        connectionString: replaceDatabaseName(DB_URL, "postgres"),
    });
    const conn = new pg.Client({ connectionString: DB_URL });
    const database = getDatabaseName(DB_URL);
    postgresUnitOfWork.bind(
        () => new pg.Client({ connectionString: DB_URL }),
        (client) => client.end()
    );
    const uow = postgresUnitOfWork;

    beforeAll(async () => {
        await privilegedConn.connect();
        await privilegedConn.query(`DROP DATABASE IF EXISTS ${database}`);
        await privilegedConn.query(`CREATE DATABASE ${database}`);

        await conn.connect();
        await conn.query(`DROP TABLE IF EXISTS _test;`);
        await conn.query(`
            CREATE TABLE _test (
                id INT
            );
        `);
    });

    afterAll(async () => {
        await conn.end();

        await privilegedConn.query(`DROP DATABASE IF EXISTS ${database}`);
        await privilegedConn.end();
    });

    beforeEach(async () => {
        await conn.query(`TRUNCATE TABLE _test;`);
    });

    test("getClient() outside of uow throws error", async () => {
        expect(() => uow.getClient()).toThrowError(/.*not started.*/);
    });

    test("client passed as argument and client from .getClient() shares the same transaction", async () => {
        const txids = new Set<string>();

        await uow.wrap(async (client) => {
            txids.add(await getTxid(client));
            txids.add(await getTxid(uow.getClient()));
        });

        expect(txids.size).toBe(1);
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
});
