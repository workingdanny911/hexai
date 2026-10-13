import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    expectTypeOf,
    test,
} from "vitest";
import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import {
    createPostgresUnitOfWork,
    DefaultPostgresUnitOfWork,
    TransactionClosedError,
} from "./postgres-unit-of-work.js";
import type { PostgresQueryable } from "./postgres-queryable.js";
import { useClient, useDatabase } from "./test-fixtures/index.js";

const DATABASE = "test_hexai__uow_db";
const TABLE = "db_rows";
const POOL_SIZE = 2;
const CONNECTION_TIMEOUT_MS = 2_000;
const SYNTAX_ERROR = "42601";
const UNDEFINED_TABLE = "42P01";
const INSERT_ROW = `INSERT INTO ${TABLE} (id) VALUES ($1)`;

class ScopeFailure extends Error {
    constructor() {
        super("scope callback failed");
        this.name = "ScopeFailure";
    }
}

class RowRepository {
    constructor(private readonly db: PostgresQueryable) {}

    async add(id: number): Promise<void> {
        await this.db.query(INSERT_ROW, [id]);
    }
}

interface Deferred {
    promise: Promise<void>;
    resolve(): void;
}

function createDeferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error("Expected the operation to reject, but it resolved");
}

async function insertRow(db: PostgresQueryable, id: number): Promise<void> {
    await db.query(INSERT_ROW, [id]);
}

async function transactionId(db: PostgresQueryable): Promise<string> {
    const result = await db.query<{ id: string }>(
        "SELECT txid_current()::text AS id"
    );
    return result.rows[0].id;
}

describe("PostgresUnitOfWork db", () => {
    const databaseUrl = useDatabase(DATABASE).toString();
    const admin = useClient(DATABASE);

    let pool: pg.Pool;
    let uow: DefaultPostgresUnitOfWork;

    beforeAll(async () => {
        await admin.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INT)`);
    });

    beforeEach(() => {
        pool = new pg.Pool({
            connectionString: databaseUrl,
            max: POOL_SIZE,
            connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        });
        uow = createPostgresUnitOfWork(pool);
    });

    afterEach(async () => {
        await pool.end();
        await admin.query(`TRUNCATE ${TABLE}`);
    });

    async function committedRowIds(): Promise<number[]> {
        const result = await admin.query<{ id: number }>(
            `SELECT id FROM ${TABLE} ORDER BY id`
        );
        return result.rows.map((row) => row.id);
    }

    function expectEveryConnectionReturned(): void {
        expect({
            idle: pool.idleCount,
            waiting: pool.waitingCount,
        }).toEqual({ idle: pool.totalCount, waiting: 0 });
    }

    const placements: Array<
        [string, (work: () => Promise<void>) => Promise<void>]
    > = [
        ["inside a scope", (work) => uow.scope(work)],
        ["outside any scope", (work) => work()],
    ];

    describe("inside a scope", () => {
        test("commits its queries with the scope", async () => {
            await uow.scope(async () => {
                await insertRow(uow.db, 1);
                await insertRow(uow.db, 2);
            });

            expect(await committedRowIds()).toEqual([1, 2]);
        });

        test("rolls back its queries when the scope fails", async () => {
            const error = await captureRejection(
                uow.scope(async () => {
                    await insertRow(uow.db, 1);
                    throw new ScopeFailure();
                })
            );

            expect(error).toBeInstanceOf(ScopeFailure);
            expect(await committedRowIds()).toEqual([]);
        });

        test("routes queries from a db taken before the scope to the scope's transaction", async () => {
            const repository = new RowRepository(uow.db);

            await captureRejection(
                uow.scope(async () => {
                    await repository.add(1);
                    throw new ScopeFailure();
                })
            );
            await uow.scope(() => repository.add(2));

            expect(await committedRowIds()).toEqual([2]);
        });

        test("shares the scope's transaction with withClient()", async () => {
            await uow.scope(async () => {
                const fromDb = await transactionId(uow.db);
                const fromClient = await uow.withClient((client) =>
                    transactionId(client)
                );

                expect(fromClient).toBe(fromDb);
            });
        });

        test("rolls back only the queries of a failed NESTED scope", async () => {
            await uow.scope(async () => {
                await insertRow(uow.db, 1);
                await captureRejection(
                    uow.scope(
                        async () => {
                            await insertRow(uow.db, 2);
                            throw new ScopeFailure();
                        },
                        { propagation: Propagation.NESTED }
                    )
                );
                await insertRow(uow.db, 3);
            });

            expect(await committedRowIds()).toEqual([1, 3]);
        });

        test("commits the queries of a NEW scope on their own", async () => {
            await captureRejection(
                uow.scope(async () => {
                    await insertRow(uow.db, 1);
                    await uow.scope(() => insertRow(uow.db, 2), {
                        propagation: Propagation.NEW,
                    });
                    throw new ScopeFailure();
                })
            );

            expect(await committedRowIds()).toEqual([2]);
        });

        test("rejects a query that work started in the scope makes after the scope ended", async () => {
            const resume = createDeferred();
            let lateQuery!: Promise<void>;

            await uow.scope(async () => {
                await insertRow(uow.db, 1);
                lateQuery = (async () => {
                    await resume.promise;
                    await insertRow(uow.db, 2);
                })();
            });
            resume.resolve();

            expect(await captureRejection(lateQuery)).toBeInstanceOf(
                TransactionClosedError
            );
            expect(await committedRowIds()).toEqual([1]);
            expectEveryConnectionReturned();
        });
    });

    describe("outside any scope", () => {
        test("commits each query at once and returns its connection", async () => {
            for (let id = 1; id <= POOL_SIZE + 1; id++) {
                await insertRow(uow.db, id);
                expect(await committedRowIds()).toContain(id);
            }

            expectEveryConnectionReturned();
        });

        test("returns the connection when a query fails", async () => {
            for (let attempt = 1; attempt <= POOL_SIZE + 1; attempt++) {
                const error = await captureRejection(
                    uow.db.query("SELECT * FROM missing_table")
                );
                expect(error).toMatchObject({ code: UNDEFINED_TABLE });
            }

            expectEveryConnectionReturned();
        });
    });

    test.each(placements)(
        "rejects two statements in one call %s",
        async (_placement, run) => {
            const error = await captureRejection(
                run(async () => {
                    await uow.db.query(
                        `INSERT INTO ${TABLE} (id) VALUES (1); INSERT INTO ${TABLE} (id) VALUES (2)`
                    );
                })
            );

            expect(error).toBeInstanceOf(pg.DatabaseError);
            expect(error).toMatchObject({ code: SYNTAX_ERROR });
            expect(await committedRowIds()).toEqual([]);
        }
    );

    test.each(placements)(
        "sends the values a query was called with %s, even if the array changes before it is sent",
        async (_placement, run) => {
            await run(async () => {
                const values = [1];
                const inserted = uow.db.query(INSERT_ROW, values);
                values[0] = 2;
                await inserted;
            });

            expect(await committedRowIds()).toEqual([1]);
        }
    );

    test("accepts pg clients and pools where a PostgresQueryable is expected", () => {
        expectTypeOf<pg.Client>().toExtend<PostgresQueryable>();
        expectTypeOf<pg.PoolClient>().toExtend<PostgresQueryable>();
        expectTypeOf<pg.Pool>().toExtend<PostgresQueryable>();
        expectTypeOf<pg.ClientBase>().toExtend<PostgresQueryable>();
        expectTypeOf<PostgresQueryable>().not.toExtend<pg.ClientBase>();
    });
});
