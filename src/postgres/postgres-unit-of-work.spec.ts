import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
} from "vitest";
import * as pg from "pg";
import * as process from "process";
import {
    POSTGRES_ISOLATION,
    postgresUnitOfWork,
} from "Hexai/postgres/postgres-unit-of-work";

const DB_URL =
    process.env.POSTGRES_URL ||
    "postgresql://postgres:postgres@localhost:5432/postgres";

class DB {
    constructor(private readonly conn: pg.Client) {}

    async insert(id: number): Promise<void> {
        await this.conn.query(`INSERT INTO _test VALUES ($1);`, [id]);
    }

    async exists(id: number): Promise<boolean> {
        const result = await this.conn.query(
            `SELECT COUNT(*) FROM _test WHERE id = $1;`,
            [id]
        );
        return result.rows[0].count > 0;
    }

    async count(): Promise<number> {
        const result = await this.conn.query(`SELECT COUNT(*) FROM _test;`);
        return parseInt(result.rows[0].count);
    }

    async getTxid(): Promise<string> {
        const result = await this.conn.query(`SELECT txid_current();`);
        return result.rows[0].txid_current;
    }
}

describe("PostgreSQL unit of work", () => {
    const privilegedConn = new pg.Client({
        connectionString: DB_URL.replace(/([\w_])+$/, "postgres"),
    });
    const conn = new pg.Client({ connectionString: DB_URL });

    const database = DB_URL.match(/([\w_])+$/)![0];
    postgresUnitOfWork.bind(
        () => new pg.Client({ connectionString: DB_URL }),
        (client) => client.end()
    );

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
        await Promise.all([conn.end(), privilegedConn.end()]);
    });

    beforeEach(async () => {
        await conn.query(`TRUNCATE TABLE _test;`);
    });

    test("getClient() outside of uow throws error", async () => {
        expect(() => postgresUnitOfWork.getClient()).toThrowError(
            /.*not started.*/
        );
    });

    test("all of the clients inside uow shares the same transaction", async () => {
        const [txid1, txid2] = await postgresUnitOfWork.wrap((client) =>
            Promise.all([new DB(client).getTxid(), new DB(client).getTxid()])
        );

        expect(txid1).toBe(txid2);
    });

    test("committing", async () => {
        await postgresUnitOfWork.wrap(async (client) => {
            await new DB(client).insert(1);
        });

        await expect(new DB(conn).exists(1)).resolves.toBe(true);
    });

    test("rolling back", async () => {
        await expect(
            postgresUnitOfWork.wrap(async (client) => {
                await new DB(client).insert(2);

                throw new Error("rollback");
            })
        ).rejects.toThrowError("rollback");

        expect(await new DB(conn).exists(2)).toBe(false);
    });

    test("nested uow - same txid", async () => {
        let txid1 = "txid1";
        let txid2 = "txid2";

        await postgresUnitOfWork.wrap(async (client) => {
            txid1 = await new DB(client).getTxid();

            await postgresUnitOfWork.wrap(async (client) => {
                txid2 = await new DB(client).getTxid();
            });
        });

        expect(txid1).toBe(txid2);
    });

    test("nested uow - rollback", async () => {
        await postgresUnitOfWork.wrap(async (client) => {
            await new DB(client).insert(1);

            expect(
                postgresUnitOfWork.wrap(async (client) => {
                    throw new Error("rollback");
                })
            ).rejects.toThrowError("rollback");
        });

        expect(await new DB(conn).count()).toBe(0);
    });

    test("nested uow - commit", async () => {
        await postgresUnitOfWork.wrap(async (client) => {
            await new DB(client).insert(1);

            await postgresUnitOfWork.wrap(async (client) => {
                await new DB(client).insert(2);
            });
        });

        expect(await new DB(conn).count()).toBe(2);
    });

    test("parallel execution in the same uow", async () => {
        const txids = await postgresUnitOfWork.wrap(async (client) => {
            const promises = Array.from({ length: 5 }, () =>
                new DB(client).getTxid()
            );

            return Promise.all(promises);
        });

        expect(txids.every((txid) => txid === txids[0])).toBe(true);
    });

    test("forcing new uow", async () => {
        const txids = await postgresUnitOfWork.wrap(async (client) => {
            const promises = Array.from({ length: 5 }, () =>
                postgresUnitOfWork.wrapWithNew((client) =>
                    new DB(client).getTxid()
                )
            );

            return Promise.all(promises);
        });

        expect(new Set(txids).size).toBe(5);
    });

    test.each([
        POSTGRES_ISOLATION.READ_COMMITTED,
        POSTGRES_ISOLATION.REPEATABLE_READ,
        POSTGRES_ISOLATION.SERIALIZABLE,
    ])("serializable isolation level", async (isolationLevel) => {
        await postgresUnitOfWork.wrap(
            async (outerClient) => {
                const result = await outerClient.query(
                    "SHOW TRANSACTION ISOLATION LEVEL"
                );

                expect(result.rows[0].transaction_isolation).toBe(
                    isolationLevel
                );
            },
            { isolationLevel }
        );
    });

    test("when options vary between nested uows", async () => {
        const txids = await postgresUnitOfWork.wrap(async (client) => {
            const promises = Array.from({ length: 5 }, () =>
                postgresUnitOfWork.wrapWithNew((client) =>
                    new DB(client).getTxid()
                )
            );

            return Promise.all(promises);
        });

        expect(new Set(txids).size).toBe(5);
    });
});
