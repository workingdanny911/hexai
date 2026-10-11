import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import { IsolationLevel } from "./types.js";
import {
    createPostgresUnitOfWork,
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
    TransactionClosedError,
} from "./postgres-unit-of-work.js";
import { useClient, useDatabase } from "./test-fixtures/index.js";

const DATABASE = "test_hexai__uow_client_release";
const DEFERRED_TABLE = "deferred_unique";
const COMMITTED_TABLE = "committed_rows";
const UNIQUE_VIOLATION = "23505";
const SYNTAX_ERROR = "42601";
const IN_FAILED_TRANSACTION = "25P02";
const DIVISION_BY_ZERO = "22012";
const POOL_SIZE = 2;
const CONNECTION_TIMEOUT_MS = 2_000;
const SETTLE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 5;
const TERMINATE_TIMEOUT_MS = 5_000;
const BROKEN_CONNECTION_MESSAGE =
    "Client has encountered a connection error and is not queryable";

class ScopeCallbackError extends Error {
    constructor() {
        super("scope callback failed");
        this.name = "ScopeCallbackError";
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

// Lets every queued promise reaction run, so the code under test reaches its
// next real wait (I/O or a held gate) before the test inspects it.
function flushPendingWork(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(
    condition: () => boolean,
    description: string
): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

function captureThrown(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error("Expected the operation to throw, but it returned");
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error("Expected the operation to reject, but it resolved");
}

async function settleWithin<T>(
    promise: Promise<T>,
    operation: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `${operation} did not settle within ${SETTLE_TIMEOUT_MS}ms`
                    )
                ),
            SETTLE_TIMEOUT_MS
        );
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function trackSettlement(promise: Promise<unknown>): () => boolean {
    let settled = false;
    const markSettled = () => {
        settled = true;
    };
    void promise.then(markSettled, markSettled);
    return () => settled;
}

// Tests terminate and close connections on purpose. Without a listener, the
// resulting 'error' events would crash the test process instead of failing
// the operation under test.
function ignoreDeliberateConnectionLoss(): void {}

describe("PostgresUnitOfWork client release", () => {
    const databaseUrl = useDatabase(DATABASE).toString();
    const admin = useClient(DATABASE);

    beforeAll(async () => {
        await admin.query(`
            CREATE TABLE IF NOT EXISTS ${DEFERRED_TABLE} (
                id INT CONSTRAINT ${DEFERRED_TABLE}_id_key
                    UNIQUE DEFERRABLE INITIALLY DEFERRED
            );
        `);
        await admin.query(
            `CREATE TABLE IF NOT EXISTS ${COMMITTED_TABLE} (id INT);`
        );
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        // Leaked clients would keep the test database open and block its drop.
        await admin.query(
            `SELECT pg_terminate_backend(pid, $2)
             FROM pg_stat_activity
             WHERE datname = $1 AND pid <> pg_backend_pid();`,
            [DATABASE, TERMINATE_TIMEOUT_MS]
        );
    });

    async function insertDuplicateDeferredRows(
        client: pg.ClientBase
    ): Promise<void> {
        await client.query(
            `INSERT INTO ${DEFERRED_TABLE} (id) VALUES (1), (1);`
        );
    }

    async function terminateConnection(client: pg.ClientBase): Promise<void> {
        client.on("error", ignoreDeliberateConnectionLoss);
        const result = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid() AS pid;"
        );
        const connectionEnded = new Promise<void>((resolve) =>
            client.once("end", () => resolve())
        );

        await admin.query("SELECT pg_terminate_backend($1, $2);", [
            result.rows[0].pid,
            TERMINATE_TIMEOUT_MS,
        ]);
        await connectionEnded;
    }

    function expectCommitConstraintViolation(error: unknown): void {
        expect(error).toBeInstanceOf(pg.DatabaseError);
        expect(error).toMatchObject({ code: UNIQUE_VIOLATION });
    }

    function expectBrokenConnectionError(error: unknown): void {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ScopeCallbackError);
        expect((error as Error).message).toBe(BROKEN_CONNECTION_MESSAGE);
    }

    function expectScopeCallbackError(error: unknown): void {
        expect(error).toBeInstanceOf(ScopeCallbackError);
    }

    function captureReportedErrors() {
        return vi.spyOn(console, "error").mockImplementation(() => {});
    }

    function expectRollbackFailureReport(
        reportedErrors: ReturnType<typeof captureReportedErrors>,
        reported: boolean
    ): void {
        const rollbackFailureReport = [
            "PostgresUnitOfWork could not roll back a transaction",
            expect.any(Error),
        ];
        if (reported) {
            expect(reportedErrors).toHaveBeenCalledWith(
                ...rollbackFailureReport
            );
        } else {
            expect(reportedErrors).not.toHaveBeenCalledWith(
                ...rollbackFailureReport
            );
        }
    }

    interface FinalizationFailure {
        description: string;
        run(uow: DefaultPostgresUnitOfWork): Promise<unknown>;
        expectCallerError(error: unknown): void;
        reportsRollbackFailure: boolean;
    }

    const finalizationFailures: FinalizationFailure[] = [
        {
            description: "COMMIT fails on a deferred constraint",
            run: (uow) =>
                uow.scope(() => uow.withClient(insertDuplicateDeferredRows)),
            expectCallerError: expectCommitConstraintViolation,
            reportsRollbackFailure: false,
        },
        {
            description: "COMMIT fails on a terminated connection",
            run: (uow) =>
                uow.scope(() => uow.withClient(terminateConnection)),
            expectCallerError: expectBrokenConnectionError,
            reportsRollbackFailure: false,
        },
        {
            description: "ROLLBACK fails on a terminated connection",
            run: (uow) =>
                uow.scope(async () => {
                    await uow.withClient(terminateConnection);
                    throw new ScopeCallbackError();
                }),
            expectCallerError: expectScopeCallbackError,
            reportsRollbackFailure: true,
        },
    ];

    describe("with a pg.Pool", () => {
        let pool: pg.Pool;
        let uow: DefaultPostgresUnitOfWork;

        function createPool(
            max: number,
            connectionTimeoutMillis = CONNECTION_TIMEOUT_MS
        ): pg.Pool {
            const created = new pg.Pool({
                connectionString: databaseUrl,
                max,
                connectionTimeoutMillis,
            });
            created.on("error", ignoreDeliberateConnectionLoss);
            created.on("connect", (client) =>
                client.on("error", ignoreDeliberateConnectionLoss)
            );
            return created;
        }

        beforeEach(() => {
            pool = createPool(POOL_SIZE);
            uow = createPostgresUnitOfWork(pool);
        });

        function poolCounts(): Record<"total" | "idle" | "waiting", number> {
            return {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
            };
        }

        async function expectPoolToEnd(target: pg.Pool = pool): Promise<void> {
            await expect(
                settleWithin(target.end(), "pool.end()")
            ).resolves.toBeUndefined();
        }

        // Sends the first BEGIN to the server right away but holds its result
        // until `release()`, so the transaction stays mid-start on a real
        // pooled connection.
        function holdFirstBeginResult(target: pg.Pool): {
            issued: Promise<void>;
            release(): void;
        } {
            const issued = createDeferred();
            const result = createDeferred();
            let held = false;

            target.on("connect", (client) => {
                const send = client.query.bind(client) as (
                    ...args: unknown[]
                ) => Promise<pg.QueryResult>;
                client.query = ((...args: unknown[]) => {
                    if (held || args[0] !== "BEGIN") {
                        return send(...args);
                    }
                    held = true;
                    const response = send(...args);
                    issued.resolve();
                    return result.promise.then(() => response);
                }) as unknown as typeof client.query;
            });

            return { issued: issued.promise, release: result.resolve };
        }

        async function countCommittedRows(): Promise<number> {
            const result = await admin.query<{ count: string }>(
                `SELECT COUNT(*) AS count FROM ${COMMITTED_TABLE};`
            );
            return Number(result.rows[0].count);
        }

        async function committedIds(): Promise<number[]> {
            const result = await admin.query<{ id: number }>(
                `SELECT id FROM ${COMMITTED_TABLE} ORDER BY id;`
            );
            return result.rows.map((row) => row.id);
        }

        test("keeps the client of a caught start failure checked out until the scope ends", async () => {
            const scopeError = await captureRejection(
                uow.scope(
                    async () => {
                        const error = await captureRejection(
                            uow.withClient(async (client) => {
                                await client.query("SELECT 1;");
                            })
                        );

                        expect(error).toMatchObject({ code: SYNTAX_ERROR });
                        expect(poolCounts()).toEqual({
                            total: 1,
                            idle: 0,
                            waiting: 0,
                        });
                        await expect(
                            uow.getClient().query("SELECT 1;")
                        ).rejects.toMatchObject({
                            code: IN_FAILED_TRANSACTION,
                        });
                    },
                    { isolationLevel: "no such level" as IsolationLevel }
                )
            );

            expect(scopeError).toBeInstanceOf(TransactionAbortedError);
            expect((scopeError as Error).cause).toMatchObject({
                code: SYNTAX_ERROR,
            });
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("keeps another borrower's commit when a failed scope's BEGIN was still in flight", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const singleClientPool = createPool(1);
            const begin = holdFirstBeginResult(singleClientPool);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const siblingFailure = new ScopeCallbackError();
            const secondCommit = createDeferred();
            let firstClientUseSettled!: Promise<void>;
            let secondInserted = false;

            const firstScopeError = captureRejection(
                sharedUow.scope(async () => {
                    const clientUse = sharedUow.withClient(async (client) => {
                        await client.query("SELECT 1;");
                    });
                    firstClientUseSettled = clientUse.then(
                        () => undefined,
                        () => undefined
                    );
                    await Promise.all([
                        clientUse,
                        begin.issued.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            await begin.issued;
            await flushPendingWork();

            const secondScope = sharedUow.scope(() =>
                sharedUow.withClient(async (client) => {
                    await client.query(
                        `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                    );
                    secondInserted = true;
                    await secondCommit.promise;
                })
            );

            // The fixed code keeps the first client checked out until BEGIN
            // settles, so the second borrower queues on a pool with no idle
            // client. The old code had already returned the connection, which
            // pg-pool hands over on the next tick. Checking idleCount keeps
            // that brief queueing from looking like the fixed behaviour.
            await waitUntil(
                () =>
                    secondInserted ||
                    (singleClientPool.waitingCount === 1 &&
                        singleClientPool.idleCount === 0),
                "the second borrower to insert or to queue on a full pool"
            );
            begin.release();
            await firstClientUseSettled;
            secondCommit.resolve();

            await expect(secondScope).resolves.toBeUndefined();
            expect(await firstScopeError).toBe(siblingFailure);
            expect(await countCommittedRows()).toBe(1);
            await expectPoolToEnd(singleClientPool);
        });

        test("refuses a failed scope's late callback query, so the next borrower commits only its own row", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const singleClientPool = createPool(1);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const siblingFailure = new ScopeCallbackError();
            const callbackHoldsClient = createDeferred();
            const lateQuery = createDeferred();
            const secondCommit = createDeferred();
            let lateClientUse!: Promise<unknown>;
            let secondInserted = false;

            const firstScopeError = captureRejection(
                sharedUow.scope(async () => {
                    const clientUse = sharedUow.withClient(async (client) => {
                        callbackHoldsClient.resolve();
                        await lateQuery.promise;
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (2);`
                        );
                    });
                    lateClientUse = clientUse.then(
                        () => undefined,
                        (error: unknown) => error
                    );
                    await Promise.all([
                        clientUse,
                        callbackHoldsClient.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            await callbackHoldsClient.promise;
            await flushPendingWork();

            const secondScope = sharedUow.scope(() =>
                sharedUow.withClient(async (client) => {
                    await client.query(
                        `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                    );
                    secondInserted = true;
                    await secondCommit.promise;
                })
            );

            // The connection goes back to the pool as soon as the first scope
            // fails, so the second borrower inserts on it. The late INSERT is
            // refused instead of joining the second borrower's transaction.
            await waitUntil(
                () =>
                    secondInserted ||
                    (singleClientPool.waitingCount === 1 &&
                        singleClientPool.idleCount === 0),
                "the second borrower to insert or to queue on a full pool"
            );
            lateQuery.resolve();
            const lateClientUseError = await settleWithin(
                lateClientUse,
                "the late withClient()"
            );
            secondCommit.resolve();

            await expect(secondScope).resolves.toBeUndefined();
            expect(await firstScopeError).toBe(siblingFailure);
            expect(await committedIds()).toEqual([1]);
            expect(lateClientUseError).toBeInstanceOf(TransactionClosedError);
            await expectPoolToEnd(singleClientPool);
        });

        test("treats a COMMIT that ends as ROLLBACK as an aborted transaction", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            let afterCommitCalled = false;
            let afterRollbackCalled = false;
            let everyCommitCalls = 0;
            const unsubscribe = uow.onEveryCommit(() => {
                everyCommitCalls++;
            });

            const error = await captureRejection(
                uow.scope(async () => {
                    uow.afterCommit(() => {
                        afterCommitCalled = true;
                    });
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await uow.withClient(async (client) => {
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                        );
                    });
                    const divisionError = await captureRejection(
                        uow.withClient((client) => client.query("SELECT 1/0;"))
                    );
                    expect(divisionError).toMatchObject({
                        code: DIVISION_BY_ZERO,
                    });
                })
            );
            unsubscribe();

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toMatchObject({
                code: DIVISION_BY_ZERO,
            });
            expect(afterRollbackCalled).toBe(true);
            expect(afterCommitCalled).toBe(false);
            expect(everyCommitCalls).toBe(0);
            expect(await countCommittedRows()).toBe(0);
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("aborts when a query the scope did not await fails before the decision, since PostgreSQL ends COMMIT as ROLLBACK", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            let unawaitedClientUse!: Promise<unknown>;

            const error = await captureRejection(
                uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                        );
                    });
                    unawaitedClientUse = captureRejection(
                        uow.withClient((client) => client.query("SELECT 1/0;"))
                    );
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toMatchObject({
                code: DIVISION_BY_ZERO,
            });
            expect(await unawaitedClientUse).toMatchObject({
                code: DIVISION_BY_ZERO,
            });
            expect(await countCommittedRows()).toBe(0);
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("gives code inside a transaction a client that behaves as the pooled one but keeps its connection", async () => {
            let keptClient!: pg.ClientBase;
            let emitterResult: unknown;
            let callbackResult!: Promise<unknown>;
            let submittableEnded!: Promise<void>;

            await uow.scope(() =>
                uow.withClient(async (client) => {
                    keptClient = client;
                    expect(client).toBeInstanceOf(pg.Client);
                    expect(client.escapeLiteral("it's")).toBe("'it''s'");
                    emitterResult = client.on("notice", () => {});
                    for (const member of ["release", "end", "connect"]) {
                        expect(() =>
                            (client as unknown as Record<string, () => void>)[
                                member
                            ]()
                        ).toThrow(`${member}() cannot be called on a client a transaction owns`);
                    }

                    callbackResult = new Promise((resolve, reject) =>
                        client.query("SELECT 1 AS one;", (error, result) =>
                            error ? reject(error) : resolve(result.rows[0].one)
                        )
                    );
                    const submitted = client.query(
                        new pg.Query("SELECT 2 AS two;")
                    );
                    submittableEnded = new Promise((resolve) =>
                        submitted.once("end", () => resolve())
                    );
                    await Promise.all([callbackResult, submittableEnded]);
                })
            );

            expect(emitterResult).toBe(keptClient);
            expect(await callbackResult).toBe(1);
            expect(() =>
                keptClient.query(new pg.Query("SELECT 3;"))
            ).toThrow(TransactionClosedError);
            await expect(keptClient.query("SELECT 4;")).rejects.toBeInstanceOf(
                TransactionClosedError
            );
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("sends a submittable query after the queries made before it", async () => {
            const applicationName = await uow.scope(() =>
                uow.withClient(async (client) => {
                    const setting = client.query(
                        "SET LOCAL application_name = 'submittable_order';"
                    );
                    const submitted = client.query(
                        new pg.Query(
                            "SELECT current_setting('application_name') AS name;"
                        )
                    );
                    const row = new Promise<{ name: string }>(
                        (resolve, reject) => {
                            submitted.once("row", resolve);
                            submitted.once("error", reject);
                        }
                    );
                    await setting;
                    return (await row).name;
                })
            );

            expect(applicationName).toBe("submittable_order");
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("hands a submittable to an idle connection within query(), so a cursor can be closed right away", async () => {
            let submittedWithinCall = false;

            await uow.scope(() =>
                uow.withClient(async (client) => {
                    const submitted = new pg.Query("SELECT 1;");
                    const submit = vi.spyOn(submitted, "submit");
                    const ended = new Promise<void>((resolve) =>
                        submitted.once("end", () => resolve())
                    );
                    client.query(submitted);
                    submittedWithinCall = submit.mock.calls.length === 1;
                    await ended;
                })
            );

            expect(submittedWithinCall).toBe(true);
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("sends each query with the config it had when query() was called", async () => {
            const numbers = await uow.scope(() =>
                uow.withClient(async (client) => {
                    const config: pg.QueryConfig = {
                        text: "SELECT $1::int AS n;",
                    };
                    const pending: Promise<pg.QueryResult>[] = [];
                    for (const n of [101, 202, 303]) {
                        config.values = [n];
                        pending.push(client.query(config));
                    }
                    const results = await Promise.all(pending);
                    return results.map((result) => result.rows[0].n);
                })
            );

            expect(numbers).toEqual([101, 202, 303]);
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("sends a config whose text is a getter, as SQL template classes define it", async () => {
            class SQLTemplate {
                constructor(
                    private readonly parts: string[],
                    readonly values: unknown[]
                ) {}

                get text(): string {
                    return this.parts
                        .map((part, index) =>
                            index === 0 ? part : `$${index}${part}`
                        )
                        .join("");
                }
            }

            const result = await uow.scope(() =>
                uow.withClient((client) =>
                    client.query(
                        new SQLTemplate(
                            ["SELECT ", "::int AS n;"],
                            [7]
                        ) as unknown as pg.QueryConfig
                    )
                )
            );

            expect(result.rows[0].n).toBe(7);
            await expectPoolToEnd();
        });

        test("sends the next query once a submittable query fails", async () => {
            let submittableFailure: unknown;

            const error = await captureRejection(
                uow.scope(() =>
                    uow.withClient((client) => {
                        client
                            .query(new pg.Query("SELECT 1/0;"))
                            .once("error", (failure: unknown) => {
                                submittableFailure = failure;
                            });
                        return client.query("SELECT 1;");
                    })
                )
            );

            expect(submittableFailure).toMatchObject({
                code: DIVISION_BY_ZERO,
            });
            expect(error).toMatchObject({ code: IN_FAILED_TRANSACTION });
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("keeps a NEW transaction that already holds a client when the scope that opened it fails", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const siblingFailure = new ScopeCallbackError();
            const newTransactionHoldsClient = createDeferred();
            let clientUse!: Promise<void>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    clientUse = uow.withClient(async (client) => {
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                        );
                        await uow.scope(
                            () =>
                                uow.withClient(async (newClient) => {
                                    newTransactionHoldsClient.resolve();
                                    await newClient.query(
                                        `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (2);`
                                    );
                                }),
                            { propagation: Propagation.NEW }
                        );
                    });
                    await Promise.all([
                        clientUse,
                        newTransactionHoldsClient.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            expect(await settleWithin(scopeError, "scope()")).toBe(
                siblingFailure
            );
            await expect(
                settleWithin(clientUse, "withClient()")
            ).resolves.toBeUndefined();
            expect(await committedIds()).toEqual([2]);
            expect(poolCounts()).toEqual({ total: 2, idle: 2, waiting: 0 });
            await expectPoolToEnd();
        });

        test("keeps the savepoint statements of a NESTED callback that fails late off the next borrower's connection", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const reportedErrors = captureReportedErrors();
            const singleClientPool = createPool(1);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const siblingFailure = new ScopeCallbackError();
            const lateNestedFailure = new Error("late nested failure");
            const firstNestedEntered = createDeferred();
            const firstNestedResume = createDeferred();
            const secondInserted = createDeferred();
            const secondResume = createDeferred();
            let firstNestedError!: Promise<unknown>;

            const firstScopeError = captureRejection(
                sharedUow.scope(async () => {
                    await sharedUow.withClient(async (client) => {
                        await client.query("SELECT 1;");
                    });
                    const nested = sharedUow.scope(
                        async () => {
                            firstNestedEntered.resolve();
                            await firstNestedResume.promise;
                            throw lateNestedFailure;
                        },
                        { propagation: Propagation.NESTED }
                    );
                    firstNestedError = captureRejection(nested);
                    await Promise.all([
                        nested,
                        firstNestedEntered.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );
            await firstNestedEntered.promise;

            // The second borrower queues for the same connection and opens its
            // own sp_1, which a savepoint rollback sent after the release would
            // hit.
            const secondScope = sharedUow.scope(async () => {
                await sharedUow.withClient(async (client) => {
                    await client.query("SELECT 1;");
                });
                await sharedUow.scope(
                    async () => {
                        await sharedUow.withClient(async (client) => {
                            await client.query(
                                `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                            );
                        });
                        secondInserted.resolve();
                        await secondResume.promise;
                    },
                    { propagation: Propagation.NESTED }
                );
            });

            await waitUntil(
                () => singleClientPool.waitingCount === 1,
                "the second borrower to queue on the full pool"
            );
            expect(await firstScopeError).toBe(siblingFailure);
            // The first NESTED callback fails while the second borrower's sp_1
            // is open on the same connection.
            await secondInserted.promise;
            firstNestedResume.resolve();
            expect(await firstNestedError).toBe(lateNestedFailure);
            secondResume.resolve();

            await expect(secondScope).resolves.toBeUndefined();
            expect(await countCommittedRows()).toBe(1);
            expect(reportedErrors).toHaveBeenCalledWith(
                "PostgresUnitOfWork could not roll back to a savepoint after a failure",
                expect.any(TransactionClosedError),
                lateNestedFailure
            );
            await expectPoolToEnd(singleClientPool);
        });

        test("refuses a participant's late query through a client taken out with getClient()", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const singleClientPool = createPool(1);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const siblingFailure = new ScopeCallbackError();
            const participantHoldsClient = createDeferred();
            const resumeParticipant = createDeferred();
            const secondCommit = createDeferred();
            let participant!: Promise<void>;
            let secondInserted = false;

            const firstScopeError = captureRejection(
                sharedUow.scope(async () => {
                    await sharedUow.withClient(async (client) => {
                        await client.query("SELECT 1;");
                    });
                    participant = sharedUow.scope(async () => {
                        const client = sharedUow.getClient();
                        participantHoldsClient.resolve();
                        await resumeParticipant.promise;
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                        );
                    });
                    await Promise.all([
                        participant,
                        participantHoldsClient.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );
            await participantHoldsClient.promise;
            await flushPendingWork();

            const secondScope = sharedUow.scope(() =>
                sharedUow.withClient(async (client) => {
                    await client.query(
                        `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (2);`
                    );
                    secondInserted = true;
                    await secondCommit.promise;
                })
            );

            // The connection goes back to the pool as soon as the first scope
            // fails. A client taken out with getClient() is the transaction's
            // gated client, so the participant's late INSERT is refused
            // instead of joining the second borrower's transaction.
            await waitUntil(
                () =>
                    secondInserted ||
                    (singleClientPool.waitingCount === 1 &&
                        singleClientPool.idleCount === 0),
                "the second borrower to insert or to queue on a full pool"
            );
            resumeParticipant.resolve();
            const participantError = await settleWithin(
                participant.then(
                    () => undefined,
                    (error: unknown) => error
                ),
                "the participant"
            );
            secondCommit.resolve();

            await expect(secondScope).resolves.toBeUndefined();
            expect(await firstScopeError).toBe(siblingFailure);
            expect(await committedIds()).toEqual([2]);
            expect(participantError).toBeInstanceOf(TransactionClosedError);
            expect({
                total: singleClientPool.totalCount,
                idle: singleClientPool.idleCount,
            }).toEqual({ total: 1, idle: 1 });
            await expectPoolToEnd(singleClientPool);
        });

        interface NewTransactionWaiter {
            description: string;
            waitFor(
                sharedUow: DefaultPostgresUnitOfWork,
                work: () => Promise<void>
            ): Promise<unknown>;
        }

        const newTransactionWaiters: NewTransactionWaiter[] = [
            {
                description: "a withClient() callback",
                waitFor: (sharedUow, work) => sharedUow.withClient(work),
            },
            {
                description: "a NESTED scope",
                waitFor: (sharedUow, work) =>
                    sharedUow.scope(work, { propagation: Propagation.NESTED }),
            },
            {
                description: "an EXISTING scope",
                waitFor: (sharedUow, work) => sharedUow.scope(work),
            },
        ];

        describe.each(newTransactionWaiters)(
            "when $description waits for a NEW transaction on an exhausted pool",
            ({ waitFor }) => {
                // Only the scope's own release can hand the NEW transaction a
                // client. The scope does not wait for the work, so it settles,
                // and the NEW transaction then starts on the released client.
                async function failSiblingWhileNewTransactionWaits(
                    openNewTransaction: (
                        sharedUow: DefaultPostgresUnitOfWork
                    ) => Promise<void>
                ) {
                    await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
                    const singleClientPool = createPool(1, 0);
                    const sharedUow =
                        createPostgresUnitOfWork(singleClientPool);
                    const reportedErrors = captureReportedErrors();
                    const siblingFailure = new ScopeCallbackError();
                    let newTransaction!: Promise<void>;
                    let workSettled!: Promise<unknown>;

                    const scopeError = captureRejection(
                        sharedUow.scope(async () => {
                            await sharedUow.withClient(async (client) => {
                                await client.query("SELECT 1;");
                            });
                            const work = waitFor(sharedUow, async () => {
                                newTransaction = openNewTransaction(sharedUow);
                                await newTransaction;
                            });
                            workSettled = work.then(
                                () => undefined,
                                () => undefined
                            );
                            await Promise.all([
                                work,
                                waitUntil(
                                    () => singleClientPool.waitingCount === 1,
                                    "the NEW transaction to queue on the full pool"
                                ).then(() => {
                                    throw siblingFailure;
                                }),
                            ]);
                        })
                    );

                    expect(await settleWithin(scopeError, "scope()")).toBe(
                        siblingFailure
                    );
                    await expect(
                        settleWithin(newTransaction, "the NEW transaction")
                    ).resolves.toBeUndefined();
                    await settleWithin(workSettled, "the waiting work");
                    expect(await committedIds()).toEqual([1]);
                    expect(reportedErrors).not.toHaveBeenCalled();
                    await expectPoolToEnd(singleClientPool);
                }

                function insertInNewTransaction(
                    sharedUow: DefaultPostgresUnitOfWork
                ): Promise<void> {
                    return sharedUow.scope(
                        () =>
                            sharedUow.withClient(async (client) => {
                                await client.query(
                                    `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                                );
                            }),
                        { propagation: Propagation.NEW }
                    );
                }

                test("lets the NEW transaction start on the released client when a sibling fails", async () => {
                    await failSiblingWhileNewTransactionWaits(
                        insertInNewTransaction
                    );
                });

                test("lets a NEW transaction opened inside another NEW one start on the released client", async () => {
                    await failSiblingWhileNewTransactionWaits((sharedUow) =>
                        sharedUow.scope(
                            () => insertInNewTransaction(sharedUow),
                            { propagation: Propagation.NEW }
                        )
                    );
                });
            }
        );

        test("lets after hooks and observers open transactions of their own", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const singleClientPool = createPool(1, 0);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const insert = (id: number) =>
                sharedUow.scope(() =>
                    sharedUow.withClient(async (client) => {
                        await client.query(
                            `INSERT INTO ${COMMITTED_TABLE} (id) VALUES ($1);`,
                            [id]
                        );
                    })
                );
            const followUps: Promise<void>[] = [];
            const unsubscribe = sharedUow.onEveryCommit(() => {
                unsubscribe();
                followUps.push(insert(3));
            });

            await sharedUow.scope(async () => {
                sharedUow.afterCommit(() => {
                    followUps.push(insert(2));
                });
                await insert(1);
            });
            await expect(
                sharedUow.scope(async () => {
                    sharedUow.afterRollback(() => {
                        followUps.push(insert(4));
                    });
                    await insert(5);
                    throw new ScopeCallbackError();
                })
            ).rejects.toBeInstanceOf(ScopeCallbackError);

            await settleWithin(Promise.all(followUps), "the follow-up scopes");
            expect(await committedIds()).toEqual([1, 2, 3, 4]);
            await expectPoolToEnd(singleClientPool);
        });

        test("keeps a NEW transaction that a beforeCommit hook opens", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);

            await uow.scope(async () => {
                uow.beforeCommit(() => insertInNewTransaction(2));
                await uow.withClient(async (client) => {
                    await client.query(
                        `INSERT INTO ${COMMITTED_TABLE} (id) VALUES (1);`
                    );
                });
            });

            expect(await committedIds()).toEqual([1, 2]);
            await expectPoolToEnd();

            function insertInNewTransaction(id: number): Promise<void> {
                return uow.scope(
                    () =>
                        uow.withClient(async (client) => {
                            await client.query(
                                `INSERT INTO ${COMMITTED_TABLE} (id) VALUES ($1);`,
                                [id]
                            );
                        }),
                    { propagation: Propagation.NEW }
                );
            }
        });

        async function runSuccessfulScope(): Promise<void> {
            await uow.scope(() =>
                uow.withClient(async (client) => {
                    await client.query("SELECT 1;");
                })
            );
        }

        test.each([undefined, null, 0, ""])(
            "removes the client from the pool when BEGIN fails with %j",
            async (failure) => {
                pool.on("connect", (client) => {
                    const send = client.query.bind(client) as (
                        ...args: unknown[]
                    ) => Promise<pg.QueryResult>;
                    client.query = ((...args: unknown[]) =>
                        args[0] === "BEGIN"
                            ? Promise.reject(failure)
                            : send(...args)) as unknown as typeof client.query;
                });

                const error = await captureRejection(
                    uow.scope(() => uow.withClient(async () => {}))
                );

                expect(error).toBe(failure);
                expect(poolCounts()).toEqual({
                    total: 0,
                    idle: 0,
                    waiting: 0,
                });
                await expectPoolToEnd();
            }
        );

        test("returns the client to the pool after a commit", async () => {
            await runSuccessfulScope();

            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        test("returns the client to the pool after a rollback", async () => {
            const error = await captureRejection(
                uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await client.query("SELECT 1;");
                    });
                    throw new ScopeCallbackError();
                })
            );

            expectScopeCallbackError(error);
            expect(poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
            await expectPoolToEnd();
        });

        for (const {
            description,
            run,
            expectCallerError,
            reportsRollbackFailure,
        } of finalizationFailures) {
            describe(`when ${description}`, () => {
                test("rejects with the expected error and removes the client from the pool", async () => {
                    const reportedErrors = captureReportedErrors();

                    const error = await captureRejection(run(uow));

                    expectCallerError(error);
                    expectRollbackFailureReport(
                        reportedErrors,
                        reportsRollbackFailure
                    );
                    expect(poolCounts()).toEqual({
                        total: 0,
                        idle: 0,
                        waiting: 0,
                    });
                    await expectPoolToEnd();
                });

                test("keeps serving scopes after more failures than the pool size", async () => {
                    captureReportedErrors();

                    for (let attempt = 1; attempt <= POOL_SIZE + 1; attempt++) {
                        expectCallerError(await captureRejection(run(uow)));
                    }

                    await expect(runSuccessfulScope()).resolves.toBeUndefined();
                    await expectPoolToEnd();
                });
            });
        }
    });

    describe("with a connection string", () => {
        let uow: DefaultPostgresUnitOfWork;

        beforeEach(() => {
            uow = createPostgresUnitOfWork(databaseUrl);
        });

        // The transaction's client is gated, so the test listens for the end
        // of the connection behind it.
        function whenEnded(client: pg.ClientBase): Promise<void> {
            return new Promise((resolve) => client.once("end", resolve));
        }

        test("ends the client after a commit", async () => {
            let clientEnded!: Promise<void>;

            await uow.scope(() =>
                uow.withClient(async (client) => {
                    clientEnded = whenEnded(client);
                })
            );

            await settleWithin(clientEnded, "the client to end");
        });

        test("ends the client when COMMIT fails", async () => {
            let clientEnded!: Promise<void>;

            const error = await captureRejection(
                uow.scope(() =>
                    uow.withClient(async (client) => {
                        clientEnded = whenEnded(client);
                        client.on("error", ignoreDeliberateConnectionLoss);
                        await insertDuplicateDeferredRows(client);
                    })
                )
            );

            expectCommitConstraintViolation(error);
            await settleWithin(clientEnded, "the client to end");
        });

        test("settles when ROLLBACK fails on a terminated connection", async () => {
            const reportedErrors = captureReportedErrors();

            const error = await settleWithin(
                captureRejection(
                    uow.scope(async () => {
                        await uow.withClient(terminateConnection);
                        throw new ScopeCallbackError();
                    })
                ),
                "scope()"
            );

            expectScopeCallbackError(error);
            expectRollbackFailureReport(reportedErrors, true);
        });
    });
});

describe("PostgresUnitOfWork client cleanup on finalization", () => {
    class ScriptedClient {
        readonly statements: string[] = [];
        // Statements sent while another one was still in flight. pg queues
        // them internally, but that queue is deprecated.
        readonly overlappingStatements: string[] = [];
        private inFlight = 0;
        private readonly failures = new Map<string, unknown>();
        private readonly synchronousFailures = new Map<string, unknown>();
        private readonly commandTags = new Map<string, string>();
        private readonly heldResults = new Map<string, Deferred>();
        private readonly sent = new Map<string, Deferred>();
        private connectFailure?: { failure: unknown };

        failOn(statement: string, failure: unknown): this {
            this.failures.set(statement, failure);
            return this;
        }

        failConnectWith(failure: unknown): this {
            this.connectFailure = { failure };
            return this;
        }

        // PostgreSQL answers COMMIT with the command tag ROLLBACK, without an
        // error, when the transaction had already failed.
        answerWithCommand(statement: string, command: string): this {
            this.commandTags.set(statement, command);
            return this;
        }

        // query() throws before returning a promise, as a ClientBase may.
        failSynchronouslyOn(statement: string, failure: unknown): this {
            this.synchronousFailures.set(statement, failure);
            return this;
        }

        holdResultOf(statement: string): Deferred {
            const result = createDeferred();
            this.heldResults.set(statement, result);
            return result;
        }

        whenSent(statement: string): Promise<void> {
            return this.sentSignal(statement).promise;
        }

        async connect(): Promise<void> {
            if (this.connectFailure) {
                throw this.connectFailure.failure;
            }
        }

        query(statement: string): Promise<pg.QueryResult> {
            this.statements.push(statement);
            if (this.inFlight > 0) {
                this.overlappingStatements.push(statement);
            }
            this.sentSignal(statement).resolve();
            if (this.synchronousFailures.has(statement)) {
                throw this.synchronousFailures.get(statement);
            }
            this.inFlight++;
            const response = this.respondTo(statement);
            const settle = () => {
                this.inFlight--;
            };
            response.then(settle, settle);
            return response;
        }

        private async respondTo(statement: string): Promise<pg.QueryResult> {
            await this.heldResults.get(statement)?.promise;
            if (this.failures.has(statement)) {
                throw this.failures.get(statement);
            }
            return {
                command: this.commandTags.get(statement) ?? statement,
                rowCount: 0,
                oid: 0,
                fields: [],
                rows: [],
            };
        }

        private sentSignal(statement: string): Deferred {
            let signal = this.sent.get(statement);
            if (!signal) {
                signal = createDeferred();
                this.sent.set(statement, signal);
            }
            return signal;
        }
    }

    interface CleanUpCall {
        args: unknown[];
        statementsSentBefore: string[];
    }

    const SET_SERIALIZABLE = `SET TRANSACTION ISOLATION LEVEL ${IsolationLevel.SERIALIZABLE}`;
    const SERIALIZABLE = { isolationLevel: IsolationLevel.SERIALIZABLE };

    let client: ScriptedClient;
    let pendingAcquisition: Deferred | undefined;
    let cleanUps: CleanUpCall[];
    let cleanUpFailure: unknown;
    let uow: DefaultPostgresUnitOfWork;

    beforeEach(() => {
        client = new ScriptedClient();
        pendingAcquisition = undefined;
        cleanUps = [];
        cleanUpFailure = undefined;
        uow = new DefaultPostgresUnitOfWork(
            () => {
                const acquired = client as unknown as pg.ClientBase;
                return pendingAcquisition
                    ? pendingAcquisition.promise.then(() => acquired)
                    : acquired;
            },
            (...args: unknown[]) => {
                cleanUps.push({
                    args,
                    statementsSentBefore: [...client.statements],
                });
                if (cleanUpFailure !== undefined) {
                    throw cleanUpFailure;
                }
            }
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        // The unit of work never hands the connection a statement while
        // another one is still in flight.
        expect(client.overlappingStatements).toEqual([]);
    });

    function holdClientAcquisition(): Deferred {
        pendingAcquisition = createDeferred();
        return pendingAcquisition;
    }

    function captureReportedErrors() {
        return vi.spyOn(console, "error").mockImplementation(() => {});
    }

    function expectCleanedUpOnceWithoutFailure(): void {
        expect(cleanUps).toHaveLength(1);
        expect(cleanUps[0].args).toHaveLength(1);
        expect(cleanUps[0].args[0]).toBe(client);
    }

    function expectCleanedUpOnceWithFailure(failure: unknown): void {
        expect(cleanUps).toHaveLength(1);
        expect(cleanUps[0].args).toHaveLength(2);
        expect(cleanUps[0].args[0]).toBe(client);
        expect(cleanUps[0].args[1]).toBe(failure);
    }

    function useClientInScope(): Promise<void> {
        return uow.withClient(async (c) => {
            await c.query("SELECT 1");
        });
    }

    function expectNoStatementAfterCleanUp(): void {
        expect(cleanUps).toHaveLength(1);
        expect(client.statements).toEqual(cleanUps[0].statementsSentBefore);
    }

    function expectCleanUpFailureReported(
        reportedErrors: ReturnType<typeof captureReportedErrors>
    ): void {
        expect(reportedErrors).toHaveBeenCalledWith(
            "PostgresUnitOfWork client cleanup failed",
            cleanUpFailure
        );
    }

    function expectRollbackFailureReported(
        reportedErrors: ReturnType<typeof captureReportedErrors>,
        rollbackFailure: unknown
    ): void {
        expect(reportedErrors).toHaveBeenCalledWith(
            "PostgresUnitOfWork could not roll back a transaction",
            rollbackFailure
        );
    }

    test("sends concurrent queries to the connection one at a time", async () => {
        const firstResult = client.holdResultOf("SELECT 1");

        const scope = uow.scope(() =>
            Promise.all([
                uow.withClient((c) => c.query("SELECT 1")),
                uow.withClient((c) => c.query("SELECT 2")),
                uow.withClient((c) => c.query("SELECT 3")),
            ])
        );

        await client.whenSent("SELECT 1");
        await flushPendingWork();
        expect(client.statements).toEqual(["BEGIN", "SELECT 1"]);
        firstResult.resolve();

        await expect(scope).resolves.toHaveLength(3);
        expect(client.statements).toEqual([
            "BEGIN",
            "SELECT 1",
            "SELECT 2",
            "SELECT 3",
            "COMMIT",
        ]);
        expect(client.overlappingStatements).toEqual([]);
    });

    test("cleans up without a failure after COMMIT succeeds", async () => {
        await uow.scope(useClientInScope);

        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
        expectCleanedUpOnceWithoutFailure();
    });

    test("cleans up without a failure after ROLLBACK succeeds", async () => {
        const callbackFailure = new ScopeCallbackError();

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                throw callbackFailure;
            })
        ).rejects.toBe(callbackFailure);

        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
        expectCleanedUpOnceWithoutFailure();
    });

    test("keeps the prevented scope's result and runs afterRollback when cleanup fails after ROLLBACK", async () => {
        cleanUpFailure = new Error("cleanup failed");
        const reportedErrors = captureReportedErrors();
        let afterRollbackCalled = false;

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                uow.preventCommit();
                return 42;
            })
        ).resolves.toBe(42);

        expect(afterRollbackCalled).toBe(true);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
        expectCleanedUpOnceWithoutFailure();
        expectCleanUpFailureReported(reportedErrors);
    });

    test("rejects with the BEGIN failure and runs afterRollback when a scope fails on BEGIN and cleanup fails", async () => {
        const beginFailure = new Error("BEGIN failed");
        client.failOn("BEGIN", beginFailure);
        cleanUpFailure = new Error("cleanup failed");
        const reportedErrors = captureReportedErrors();
        let afterRollbackCalled = false;

        await expect(
            uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                await useClientInScope();
            })
        ).rejects.toBe(beginFailure);

        expect(afterRollbackCalled).toBe(true);
        expect(client.statements).toEqual(["BEGIN"]);
        expectCleanedUpOnceWithFailure(beginFailure);
        expectCleanUpFailureReported(reportedErrors);
    });

    test("rejects with the sibling's error and runs afterRollback when a sibling fails while SET TRANSACTION is held and cleanup fails", async () => {
        const heldSet = client.holdResultOf(SET_SERIALIZABLE);
        cleanUpFailure = new Error("cleanup failed");
        const reportedErrors = captureReportedErrors();
        const siblingFailure = new ScopeCallbackError();
        let afterRollbackCalled = false;
        let clientUseError!: Promise<unknown>;

        const scopeError = captureRejection(
            uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                const clientUse = useClientInScope();
                clientUseError = captureRejection(clientUse);
                await Promise.all([
                    clientUse,
                    client.whenSent(SET_SERIALIZABLE).then(() => {
                        throw siblingFailure;
                    }),
                ]);
            }, SERIALIZABLE)
        );

        await client.whenSent(SET_SERIALIZABLE);
        await flushPendingWork();
        heldSet.resolve();

        expect(await scopeError).toBe(siblingFailure);
        expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
        expect(afterRollbackCalled).toBe(true);
        expect(client.statements).toEqual([
            "BEGIN",
            SET_SERIALIZABLE,
            "ROLLBACK",
        ]);
        expectCleanedUpOnceWithoutFailure();
        expectCleanUpFailureReported(reportedErrors);
    });

    test("rejects with the sibling's error and gives the withClient() call the BEGIN failure when a sibling fails while BEGIN is held, BEGIN then fails and cleanup fails", async () => {
        const heldBegin = client.holdResultOf("BEGIN");
        const beginFailure = new Error("BEGIN failed");
        client.failOn("BEGIN", beginFailure);
        cleanUpFailure = new Error("cleanup failed");
        const reportedErrors = captureReportedErrors();
        const siblingFailure = new ScopeCallbackError();
        let afterRollbackCalled = false;
        let clientUseError!: Promise<unknown>;

        const scopeError = captureRejection(
            uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                const clientUse = useClientInScope();
                clientUseError = captureRejection(clientUse);
                await Promise.all([
                    clientUse,
                    client.whenSent("BEGIN").then(() => {
                        throw siblingFailure;
                    }),
                ]);
            })
        );

        await client.whenSent("BEGIN");
        await flushPendingWork();
        heldBegin.resolve();

        expect(await scopeError).toBe(siblingFailure);
        expect(await clientUseError).toBe(beginFailure);
        expect(afterRollbackCalled).toBe(true);
        expect(client.statements).toEqual(["BEGIN"]);
        expectCleanedUpOnceWithFailure(beginFailure);
        expectCleanUpFailureReported(reportedErrors);
    });

    test("passes the COMMIT failure to cleanup and rethrows it", async () => {
        const commitFailure = new Error("COMMIT failed");
        client.failOn("COMMIT", commitFailure);

        await expect(uow.scope(useClientInScope)).rejects.toBe(commitFailure);

        expectCleanedUpOnceWithFailure(commitFailure);
    });

    test("sends a query that got in before the decision ahead of a COMMIT that fails synchronously", async () => {
        const commitFailure = new Error("COMMIT failed");
        client.failSynchronouslyOn("COMMIT", commitFailure);
        const callbackHoldsClient = createDeferred();
        let lateClientUse!: Promise<void>;

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                lateClientUse = uow.withClient(async (c) => {
                    callbackHoldsClient.resolve();
                    await c.query("SELECT 2");
                });
                await callbackHoldsClient.promise;
            })
        ).rejects.toBe(commitFailure);

        await expect(lateClientUse).resolves.toBeUndefined();
        expect(client.statements).toEqual([
            "BEGIN",
            "SELECT 1",
            "SELECT 2",
            "COMMIT",
        ]);
        expectCleanedUpOnceWithFailure(commitFailure);
        expectNoStatementAfterCleanUp();
    });

    test("passes the ROLLBACK failure to cleanup, reports it and rejects with the callback error", async () => {
        const rollbackFailure = new Error("ROLLBACK failed");
        client.failOn("ROLLBACK", rollbackFailure);
        const reportedErrors = captureReportedErrors();
        const callbackFailure = new ScopeCallbackError();
        let afterRollbackCalled = false;

        await expect(
            uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                await useClientInScope();
                throw callbackFailure;
            })
        ).rejects.toBe(callbackFailure);

        expect(afterRollbackCalled).toBe(true);
        expectCleanedUpOnceWithFailure(rollbackFailure);
        expectRollbackFailureReported(reportedErrors, rollbackFailure);
    });

    test("passes the ROLLBACK failure to cleanup and rejects with the hook failure when a beforeCommit hook fails", async () => {
        const rollbackFailure = new Error("ROLLBACK failed");
        client.failOn("ROLLBACK", rollbackFailure);
        const reportedErrors = captureReportedErrors();
        const hookFailure = new Error("beforeCommit hook failed");

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                uow.beforeCommit(() => {
                    throw hookFailure;
                });
            })
        ).rejects.toBe(hookFailure);

        expectCleanedUpOnceWithFailure(rollbackFailure);
        expectRollbackFailureReported(reportedErrors, rollbackFailure);
    });

    test("cleans up once without a failure when an afterCommit hook fails", async () => {
        const hookFailure = new Error("afterCommit hook failed");

        const error = await captureRejection(
            uow.scope(async () => {
                await useClientInScope();
                uow.afterCommit(() => {
                    throw hookFailure;
                });
            })
        );

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([hookFailure]);
        expectCleanedUpOnceWithoutFailure();
    });

    test("keeps the result and runs afterCommit hooks when cleanup fails after a successful COMMIT", async () => {
        cleanUpFailure = new Error("cleanup failed");
        const reportedErrors = captureReportedErrors();
        let afterCommitCalled = false;
        let everyCommitCalls = 0;
        const unsubscribe = uow.onEveryCommit(() => {
            everyCommitCalls++;
        });

        await expect(
            uow.scope(async () => {
                uow.afterCommit(() => {
                    afterCommitCalled = true;
                });
                await useClientInScope();
                return 42;
            })
        ).resolves.toBe(42);
        unsubscribe();

        expect(afterCommitCalled).toBe(true);
        expect(everyCommitCalls).toBe(1);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
        expectCleanedUpOnceWithoutFailure();
        expectCleanUpFailureReported(reportedErrors);
    });

    test("treats a COMMIT that ends as ROLLBACK as an aborted transaction", async () => {
        client.answerWithCommand("COMMIT", "ROLLBACK");
        const queryFailure = new Error("query failed");
        client.failOn("SELECT 1", queryFailure);
        let afterCommitCalled = false;
        let afterRollbackCalled = false;
        let everyCommitCalls = 0;
        const unsubscribe = uow.onEveryCommit(() => {
            everyCommitCalls++;
        });

        const error = await captureRejection(
            uow.scope(async () => {
                uow.afterCommit(() => {
                    afterCommitCalled = true;
                });
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                await expect(useClientInScope()).rejects.toBe(queryFailure);
            })
        );
        unsubscribe();

        expect(error).toBeInstanceOf(TransactionAbortedError);
        expect((error as Error).cause).toBe(queryFailure);
        expect(afterRollbackCalled).toBe(true);
        expect(afterCommitCalled).toBe(false);
        expect(everyCommitCalls).toBe(0);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
        expectCleanedUpOnceWithoutFailure();
    });

    describe("when the transaction cannot start", () => {
        test.each([
            {
                entry: "scope()",
                enter: (uow: DefaultPostgresUnitOfWork) =>
                    uow.scope(() => uow.withClient(async () => {})),
            },
        ])("releases a client whose connect fails during the start of $entry", async ({ enter }) => {
            const connectFailure = new Error("connect failed");
            client.failConnectWith(connectFailure);

            await expect(enter(uow)).rejects.toBe(connectFailure);

            expect(client.statements).toEqual([]);
            expectCleanedUpOnceWithFailure(connectFailure);
        });

        test("passes the BEGIN failure to cleanup when the failure fails the scope", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);
            let afterRollbackCalled = false;

            await expect(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await useClientInScope();
                })
            ).rejects.toBe(beginFailure);

            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual(["BEGIN"]);
            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("rolls back, cleans up and runs afterRollback when a SET TRANSACTION failure fails the scope", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);
            let afterRollbackCalled = false;

            await expect(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await useClientInScope();
                }, SERIALIZABLE)
            ).rejects.toBe(isolationFailure);

            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("aborts the scope and passes the BEGIN failure to cleanup when the scope swallows it", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);

            const error = await captureRejection(
                uow.scope(async () => {
                    await expect(useClientInScope()).rejects.toBe(
                        beginFailure
                    );
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toBe(beginFailure);
            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("keeps the client until the scope ends after it swallows a BEGIN failure", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);

            const error = await captureRejection(
                uow.scope(async () => {
                    await expect(useClientInScope()).rejects.toBe(
                        beginFailure
                    );

                    expect(uow.getClient()).toBeInstanceOf(ScriptedClient);
                    await expect(useClientInScope()).rejects.toBe(
                        beginFailure
                    );
                    expect(cleanUps).toEqual([]);
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect(client.statements).toEqual(["BEGIN"]);
            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("rolls back instead of committing when the scope swallows a SET TRANSACTION failure", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);
            let afterCommitCalled = false;
            let afterRollbackCalled = false;

            const error = await captureRejection(
                uow.scope(async () => {
                    uow.afterCommit(() => {
                        afterCommitCalled = true;
                    });
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await expect(useClientInScope()).rejects.toBe(
                        isolationFailure
                    );

                    expect(uow.getClient()).toBeInstanceOf(ScriptedClient);
                    await expect(useClientInScope()).rejects.toBe(
                        isolationFailure
                    );
                    expect(cleanUps).toEqual([]);
                }, SERIALIZABLE)
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toBe(isolationFailure);
            expect(afterCommitCalled).toBe(false);
            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("still aborts the root scope when a nested scope's start failure is swallowed", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);
            let afterRollbackCalled = false;

            const error = await captureRejection(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await expect(uow.scope(useClientInScope)).rejects.toBe(
                        beginFailure
                    );
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toBe(beginFailure);
            expect(afterRollbackCalled).toBe(true);
            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("rejects a scope with the SET TRANSACTION failure and runs afterRollback when the ROLLBACK after it also fails", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            const rollbackFailure = new Error("ROLLBACK failed");
            client
                .failOn(SET_SERIALIZABLE, isolationFailure)
                .failOn("ROLLBACK", rollbackFailure);
            const reportedErrors = captureReportedErrors();
            let afterRollbackCalled = false;

            await expect(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await useClientInScope();
                }, SERIALIZABLE)
            ).rejects.toBe(isolationFailure);

            expectRollbackFailureReported(reportedErrors, rollbackFailure);
            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithFailure(rollbackFailure);
        });

        test("rejects a scope with the start failure when cleanup after the follow-up ROLLBACK fails", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);
            cleanUpFailure = new Error("cleanup failed");
            const reportedErrors = captureReportedErrors();

            await expect(
                uow.scope(useClientInScope, SERIALIZABLE)
            ).rejects.toBe(isolationFailure);

            expectCleanedUpOnceWithoutFailure();
            expect(reportedErrors).toHaveBeenCalledWith(
                expect.any(String),
                cleanUpFailure
            );
        });
    });

    describe("when the start is still in flight at finalization", () => {
        test("waits for a held BEGIN before rolling back for a failed sibling", async () => {
            const beginResult = client.holdResultOf("BEGIN");
            const siblingFailure = new ScopeCallbackError();
            let clientUseError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    const clientUse = useClientInScope();
                    clientUseError = captureRejection(clientUse);
                    await Promise.all([
                        clientUse,
                        client.whenSent("BEGIN").then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            await client.whenSent("BEGIN");
            await flushPendingWork();

            expect(client.statements).toEqual(["BEGIN"]);
            expect(cleanUps).toEqual([]);

            beginResult.resolve();

            expect(await scopeError).toBe(siblingFailure);
            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
            expectCleanedUpOnceWithoutFailure();
            expect(cleanUps[0].statementsSentBefore).toEqual([
                "BEGIN",
                "ROLLBACK",
            ]);
        });

        test("waits for a held SET TRANSACTION before rolling back for a failed sibling", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            const siblingFailure = new ScopeCallbackError();
            let clientUseError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    const clientUse = useClientInScope();
                    clientUseError = captureRejection(clientUse);
                    await Promise.all([
                        clientUse,
                        client.whenSent(SET_SERIALIZABLE).then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                }, SERIALIZABLE)
            );

            await client.whenSent(SET_SERIALIZABLE);
            await flushPendingWork();

            expect(client.statements).toEqual(["BEGIN", SET_SERIALIZABLE]);
            expect(cleanUps).toEqual([]);

            setResult.resolve();

            expect(await scopeError).toBe(siblingFailure);
            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithoutFailure();
            expect(cleanUps[0].statementsSentBefore).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
        });

        test("rolls back instead of committing when the callback returns during a held SET TRANSACTION", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            let clientUseError!: Promise<unknown>;
            let afterCommitCalled = false;
            let everyCommitCalls = 0;
            const unsubscribe = uow.onEveryCommit(() => {
                everyCommitCalls++;
            });

            const scope = uow.scope(async () => {
                uow.afterCommit(() => {
                    afterCommitCalled = true;
                });
                clientUseError = captureRejection(useClientInScope());
                await client.whenSent(SET_SERIALIZABLE);
            }, SERIALIZABLE);

            await client.whenSent(SET_SERIALIZABLE);
            await flushPendingWork();

            expect(client.statements).toEqual(["BEGIN", SET_SERIALIZABLE]);
            expect(cleanUps).toEqual([]);

            setResult.resolve();

            await expect(scope).resolves.toBeUndefined();
            unsubscribe();
            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithoutFailure();
            expect(afterCommitCalled).toBe(false);
            expect(everyCommitCalls).toBe(0);
        });

        test("does not wait for a pending client acquisition when a sibling fails", async () => {
            const acquisition = holdClientAcquisition();
            const siblingFailure = new ScopeCallbackError();
            let clientUseError!: Promise<unknown>;

            const scopeError = await settleWithin(
                captureRejection(
                    uow.scope(async () => {
                        clientUseError = captureRejection(useClientInScope());
                        throw siblingFailure;
                    })
                ),
                "scope()"
            );

            expect(scopeError).toBe(siblingFailure);
            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(cleanUps).toEqual([]);

            acquisition.resolve();

            await waitUntil(
                () => cleanUps.length > 0,
                "the late client to be released"
            );
            expect(client.statements).toEqual([]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("does not wait for a pending client acquisition when the callback returns", async () => {
            const acquisition = holdClientAcquisition();
            let clientUseError!: Promise<unknown>;

            await settleWithin(
                uow.scope(async () => {
                    clientUseError = captureRejection(useClientInScope());
                }),
                "scope()"
            );

            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(cleanUps).toEqual([]);

            acquisition.resolve();

            await waitUntil(
                () => cleanUps.length > 0,
                "the late client to be released"
            );
            expect(client.statements).toEqual([]);
            expectCleanedUpOnceWithoutFailure();
        });
    });

    describe("when a withClient() callback is still running at finalization", () => {
        test("rolls back without waiting for a sibling callback and refuses its later query", async () => {
            const siblingFailure = new ScopeCallbackError();
            const callbackHoldsClient = createDeferred();
            const resumeCallback = createDeferred();
            let clientUse!: Promise<void>;

            const scope = uow.scope(async () => {
                clientUse = uow.withClient(async (c) => {
                    await c.query("SELECT 1");
                    callbackHoldsClient.resolve();
                    await resumeCallback.promise;
                    await c.query("SELECT 2");
                });
                await Promise.all([
                    clientUse,
                    callbackHoldsClient.promise.then(() => {
                        throw siblingFailure;
                    }),
                ]);
            });

            await expect(settleWithin(scope, "scope()")).rejects.toBe(
                siblingFailure
            );
            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
            expectCleanedUpOnceWithoutFailure();

            resumeCallback.resolve();

            await expect(clientUse).rejects.toBeInstanceOf(
                TransactionClosedError
            );
            expectNoStatementAfterCleanUp();
        });

        test("commits without waiting for a callback the scope did not await and refuses its later query", async () => {
            const callbackHoldsClient = createDeferred();
            const resumeCallback = createDeferred();
            let lateClientUse!: Promise<void>;

            const scope = uow.scope(async () => {
                await useClientInScope();
                lateClientUse = uow.withClient(async (c) => {
                    callbackHoldsClient.resolve();
                    await resumeCallback.promise;
                    await c.query("SELECT 2");
                });
                await callbackHoldsClient.promise;
            });

            await expect(settleWithin(scope, "scope()")).resolves.toBeUndefined();
            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
            expectCleanedUpOnceWithoutFailure();

            resumeCallback.resolve();

            await expect(lateClientUse).rejects.toBeInstanceOf(
                TransactionClosedError
            );
            expectNoStatementAfterCleanUp();
        });

        test("sends the queries that got in before the decision ahead of COMMIT", async () => {
            const firstResult = client.holdResultOf("SELECT 1");
            let unawaitedClientUse!: Promise<void>;

            const scope = uow.scope(async () => {
                await uow.withClient(async () => {});
                unawaitedClientUse = uow.withClient(async (c) => {
                    await Promise.all([c.query("SELECT 1"), c.query("SELECT 2")]);
                });
                await client.whenSent("SELECT 1");
            });

            await client.whenSent("SELECT 1");
            await flushPendingWork();
            expect(client.statements).toEqual(["BEGIN", "SELECT 1"]);

            firstResult.resolve();

            await expect(settleWithin(scope, "scope()")).resolves.toBeUndefined();
            await expect(unawaitedClientUse).resolves.toBeUndefined();
            expect(client.statements).toEqual([
                "BEGIN",
                "SELECT 1",
                "SELECT 2",
                "COMMIT",
            ]);
            expectCleanedUpOnceWithoutFailure();
            expectNoStatementAfterCleanUp();
        });

        test("aborts on the COMMIT tag when a query the scope did not await failed before the decision", async () => {
            const queryFailure = new Error("division by zero");
            client
                .failOn("SELECT 1/0", queryFailure)
                .answerWithCommand("COMMIT", "ROLLBACK");
            let unawaitedClientUse!: Promise<unknown>;
            let afterCommitCalled = false;
            let afterRollbackCalled = false;

            const error = await captureRejection(
                uow.scope(async () => {
                    uow.afterCommit(() => {
                        afterCommitCalled = true;
                    });
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await useClientInScope();
                    unawaitedClientUse = captureRejection(
                        uow.withClient((c) => c.query("SELECT 1/0"))
                    );
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            expect((error as Error).cause).toBe(queryFailure);
            expect(await unawaitedClientUse).toBe(queryFailure);
            expect(afterCommitCalled).toBe(false);
            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual([
                "BEGIN",
                "SELECT 1",
                "SELECT 1/0",
                "COMMIT",
            ]);
            expectCleanedUpOnceWithoutFailure();
        });

        // Only the scope that created the transaction finalizes it, so a scope
        // inside a callback that outlives the failed root scope settles on its
        // own.
        test("settles when a withClient() callback awaits a scope that outlives the failed root scope", async () => {
            const siblingFailure = new ScopeCallbackError();
            const innerEntered = createDeferred();
            const finishInner = createDeferred();
            let clientUse!: Promise<void>;

            const scope = uow.scope(async () => {
                clientUse = uow.withClient(async () => {
                    await uow.scope(async () => {
                        innerEntered.resolve();
                        await finishInner.promise;
                    });
                });
                await Promise.all([
                    clientUse,
                    innerEntered.promise.then(() => {
                        throw siblingFailure;
                    }),
                ]);
            });
            const scopeError = captureRejection(scope);

            await innerEntered.promise;
            await flushPendingWork();
            finishInner.resolve();

            expect(await settleWithin(scopeError, "scope()")).toBe(
                siblingFailure
            );
            await expect(
                settleWithin(clientUse, "withClient()")
            ).resolves.toBeUndefined();
            expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("rejects new work from a callback that outlives the transaction with TransactionClosedError", async () => {
            const siblingFailure = new ScopeCallbackError();
            const callbackHoldsClient = createDeferred();
            const resumeCallback = createDeferred();
            let lateAttempts!: Promise<unknown[]>;
            let participantRan = false;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    const clientUse = uow.withClient(async () => {
                        callbackHoldsClient.resolve();
                        await resumeCallback.promise;
                        lateAttempts = Promise.all([
                            captureRejection(useClientInScope()),
                            captureRejection(
                                uow.scope(async () => {
                                    participantRan = true;
                                })
                            ),
                            captureThrown(() => uow.afterCommit(() => {})),
                        ]);
                        await lateAttempts;
                    });
                    await Promise.all([
                        clientUse,
                        callbackHoldsClient.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            await callbackHoldsClient.promise;
            await flushPendingWork();
            resumeCallback.resolve();

            expect(await scopeError).toBe(siblingFailure);
            await waitUntil(
                () => lateAttempts !== undefined,
                "the callback to try more work"
            );
            const lateErrors = await lateAttempts;
            expect(lateErrors).toHaveLength(3);
            for (const lateError of lateErrors) {
                expect(lateError).toBeInstanceOf(TransactionClosedError);
            }
            expect(participantRan).toBe(false);
            expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("keeps the commit when the scope awaited and caught the callback's failure", async () => {
            const callbackFailure = new ScopeCallbackError();

            await uow.scope(async () => {
                await expect(
                    uow.withClient(async (c) => {
                        await c.query("SELECT 1");
                        throw callbackFailure;
                    })
                ).rejects.toBe(callbackFailure);
            });

            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
            expectCleanedUpOnceWithoutFailure();
        });
    });

    test("rejects a scope() that joins after the outcome was decided without running its callback", async () => {
        const rootFinished = createDeferred();
        let participantRan = false;
        let participantError!: Promise<unknown>;

        await uow.scope(async () => {
            await useClientInScope();
            participantError = captureRejection(
                rootFinished.promise.then(() =>
                    uow.scope(async () => {
                        participantRan = true;
                    })
                )
            );
        });
        rootFinished.resolve();

        expect(await participantError).toBeInstanceOf(TransactionClosedError);
        expect(participantRan).toBe(false);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
        expectNoStatementAfterCleanUp();
    });

    describe("when a participant scope is still running at finalization", () => {
        test("rolls back without waiting for a participant the failed owner did not await, and refuses its later work", async () => {
            const ownerFailure = new ScopeCallbackError();
            const participantEntered = createDeferred();
            const resumeParticipant = createDeferred();
            let participant!: Promise<void>;
            let afterRollbackCalled = false;

            const scope = uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                await useClientInScope();
                participant = uow.scope(async () => {
                    participantEntered.resolve();
                    await resumeParticipant.promise;
                    await uow.withClient(async (c) => {
                        await c.query("SELECT 2");
                    });
                });
                await participantEntered.promise;
                throw ownerFailure;
            });

            await expect(settleWithin(scope, "scope()")).rejects.toBe(
                ownerFailure
            );
            expect(afterRollbackCalled).toBe(true);
            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
            expectCleanedUpOnceWithoutFailure();

            resumeParticipant.resolve();

            await expect(participant).rejects.toBeInstanceOf(
                TransactionClosedError
            );
            expectNoStatementAfterCleanUp();
        });

        test("commits without waiting for a participant the owner did not await, and refuses its later work", async () => {
            const resumeParticipant = createDeferred();
            let participant!: Promise<void>;

            const scope = uow.scope(async () => {
                await useClientInScope();
                participant = uow.scope(async () => {
                    await resumeParticipant.promise;
                    await uow.withClient(async (c) => {
                        await c.query("SELECT 2");
                    });
                });
            });

            await expect(settleWithin(scope, "scope()")).resolves.toBeUndefined();
            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
            expectCleanedUpOnceWithoutFailure();

            resumeParticipant.resolve();

            await expect(participant).rejects.toBeInstanceOf(
                TransactionClosedError
            );
            expectNoStatementAfterCleanUp();
        });

        test("commits without waiting for a participant a beforeCommit hook did not await", async () => {
            const resumeParticipant = createDeferred();
            const lateFailure = new ScopeCallbackError();
            let participantError!: Promise<unknown>;
            let afterCommitCalled = false;
            let afterRollbackCalled = false;

            const scope = uow.scope(async () => {
                uow.afterCommit(() => {
                    afterCommitCalled = true;
                });
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                uow.beforeCommit(() => {
                    participantError = captureRejection(
                        uow.scope(async () => {
                            await resumeParticipant.promise;
                            throw lateFailure;
                        })
                    );
                });
                await useClientInScope();
            });

            await expect(settleWithin(scope, "scope()")).resolves.toBeUndefined();
            expect(afterCommitCalled).toBe(true);
            expect(afterRollbackCalled).toBe(false);
            expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);

            resumeParticipant.resolve();

            expect(await participantError).toBe(lateFailure);
            expectCleanedUpOnceWithoutFailure();
        });

        test("accepts queries a beforeCommit hook starts and refuses queries from outside the hooks", async () => {
            const hookStarted = createDeferred();
            const resumeHook = createDeferred();
            let outsideClient!: pg.ClientBase;
            let outsideQueryError!: Promise<unknown>;

            const scope = uow.scope(async () => {
                await uow.withClient(async (c) => {
                    outsideClient = c;
                    await c.query("SELECT 1");
                });
                uow.beforeCommit(async () => {
                    hookStarted.resolve();
                    await resumeHook.promise;
                    await uow.withClient(async (c) => {
                        await c.query("SELECT hook");
                    });
                });
            });

            await hookStarted.promise;
            outsideQueryError = captureRejection(
                outsideClient.query("SELECT outside")
            );
            resumeHook.resolve();

            await expect(settleWithin(scope, "scope()")).resolves.toBeUndefined();
            expect(await outsideQueryError).toBeInstanceOf(
                TransactionClosedError
            );
            expect(client.statements).toEqual([
                "BEGIN",
                "SELECT 1",
                "SELECT hook",
                "COMMIT",
            ]);
            expectCleanedUpOnceWithoutFailure();
        });
    });

    describe("releases the client exactly once and sends nothing after release", () => {
        interface HeldPoint {
            description: string;
            hold(): { reached(): Promise<void>; release(): void };
        }

        interface Trigger {
            description: string;
            runScope(
                enterWork: () => Promise<unknown>,
                reached: () => Promise<void>
            ): Promise<void>;
        }

        function holdStatement(statement: string) {
            const result = client.holdResultOf(statement);
            return {
                reached: () => client.whenSent(statement),
                release: result.resolve,
            };
        }

        // One NESTED scope passes every point in order: client acquisition,
        // BEGIN, SET TRANSACTION, SAVEPOINT, the callback's query, RELEASE.
        const heldPoints: HeldPoint[] = [
            {
                description: "client acquisition",
                hold: () => {
                    const acquisition = holdClientAcquisition();
                    return {
                        reached: flushPendingWork,
                        release: acquisition.resolve,
                    };
                },
            },
            { description: "BEGIN", hold: () => holdStatement("BEGIN") },
            {
                description: "SET TRANSACTION",
                hold: () => holdStatement(SET_SERIALIZABLE),
            },
            {
                description: "SAVEPOINT",
                hold: () => holdStatement("SAVEPOINT sp_1"),
            },
            {
                description: "a callback's query",
                hold: () => holdStatement("SELECT 1"),
            },
            {
                description: "RELEASE SAVEPOINT",
                hold: () => holdStatement("RELEASE SAVEPOINT sp_1"),
            },
        ];

        const triggers: Trigger[] = [
            {
                description: "a sibling fails",
                runScope: async (enterWork, reached) => {
                    await Promise.all([
                        enterWork(),
                        reached().then(() => {
                            throw new ScopeCallbackError();
                        }),
                    ]);
                },
            },
            {
                description: "the scope returns",
                runScope: async (enterWork, reached) => {
                    void enterWork();
                    await reached();
                },
            },
            {
                description: "the scope prevents the commit and returns",
                runScope: async (enterWork, reached) => {
                    uow.preventCommit();
                    void enterWork();
                    await reached();
                },
            },
        ];

        for (const point of heldPoints) {
            for (const trigger of triggers) {
                test(`when ${trigger.description} while ${point.description} is held`, async () => {
                    const held = point.hold();
                    let workSettled!: Promise<void>;
                    const enterWork = () => {
                        const work = uow.scope(useClientInScope, {
                            propagation: Propagation.NESTED,
                        });
                        workSettled = work.then(
                            () => undefined,
                            () => undefined
                        );
                        return work;
                    };

                    const scopeSettled = uow
                        .scope(
                            () => trigger.runScope(enterWork, held.reached),
                            SERIALIZABLE
                        )
                        .then(
                            () => undefined,
                            () => undefined
                        );

                    await held.reached();
                    await flushPendingWork();
                    held.release();

                    await settleWithin(scopeSettled, "scope()");
                    await settleWithin(workSettled, "the NESTED scope");
                    await waitUntil(
                        () => cleanUps.length > 0,
                        "the client to be released"
                    );
                    expectNoStatementAfterCleanUp();
                });
            }
        }
    });

    describe("when nested work reaches the client after the transaction closed", () => {
        const NESTED_STATEMENT = "INSERT nested";

        let nestedCallbackRan: boolean;

        beforeEach(() => {
            nestedCallbackRan = false;
        });

        const nestedEntries: Array<{
            description: string;
            operation: string;
            enter(): Promise<unknown>;
        }> = [
            {
                description: "a NESTED scope",
                operation: "scope()",
                enter: () =>
                    uow.scope(
                        async () => {
                            nestedCallbackRan = true;
                            await uow.withClient(async (c) => {
                                await c.query(NESTED_STATEMENT);
                            });
                        },
                        { propagation: Propagation.NESTED }
                    ),
            },
        ];

        for (const { description, operation, enter } of nestedEntries) {
            function expectClosedErrorFor(error: unknown): void {
                expect(error).toBeInstanceOf(TransactionClosedError);
                expect((error as Error).message).toBe(
                    new TransactionClosedError(operation).message
                );
            }

            describe(description, () => {
                test("is rejected when a sibling fails while BEGIN is held", async () => {
                    const beginResult = client.holdResultOf("BEGIN");
                    const siblingFailure = new ScopeCallbackError();
                    let nestedError!: Promise<unknown>;

                    const scopeError = captureRejection(
                        uow.scope(async () => {
                            const nested = enter();
                            nestedError = captureRejection(nested);
                            await Promise.all([
                                nested,
                                client.whenSent("BEGIN").then(() => {
                                    throw siblingFailure;
                                }),
                            ]);
                        })
                    );

                    await client.whenSent("BEGIN");
                    await flushPendingWork();
                    beginResult.resolve();

                    expect(await scopeError).toBe(siblingFailure);
                    expectClosedErrorFor(await nestedError);
                    expect(nestedCallbackRan).toBe(false);
                    expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
                    expectNoStatementAfterCleanUp();
                });

                test("is rejected when a sibling fails while client acquisition is held", async () => {
                    const acquisition = holdClientAcquisition();
                    const siblingFailure = new ScopeCallbackError();
                    let nestedError!: Promise<unknown>;

                    const scopeError = await captureRejection(
                        uow.scope(async () => {
                            nestedError = captureRejection(enter());
                            throw siblingFailure;
                        })
                    );

                    expect(scopeError).toBe(siblingFailure);
                    expectClosedErrorFor(await nestedError);

                    acquisition.resolve();

                    await waitUntil(
                        () => cleanUps.length > 0,
                        "the late client to be released"
                    );
                    expect(nestedCallbackRan).toBe(false);
                    expect(client.statements).toEqual([]);
                    expectNoStatementAfterCleanUp();
                });

                test("is rejected when entered after the root scope finished", async () => {
                    const rootFinished = createDeferred();
                    let nestedError!: Promise<unknown>;

                    await uow.scope(async () => {
                        await useClientInScope();
                        nestedError = captureRejection(
                            rootFinished.promise.then(() => enter())
                        );
                    });
                    rootFinished.resolve();

                    expectClosedErrorFor(await nestedError);
                    expect(nestedCallbackRan).toBe(false);
                    expect(client.statements).toEqual([
                        "BEGIN",
                        "SELECT 1",
                        "COMMIT",
                    ]);
                    expectNoStatementAfterCleanUp();
                });
            });
        }

        test("a NESTED scope whose SAVEPOINT is held when a sibling fails does not run its callback", async () => {
            const savepointResult = client.holdResultOf("SAVEPOINT sp_1");
            const siblingFailure = new ScopeCallbackError();
            let nestedError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    await useClientInScope();
                    const nested = nestedEntries[0].enter();
                    nestedError = captureRejection(nested);
                    await Promise.all([
                        nested,
                        client.whenSent("SAVEPOINT sp_1").then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                })
            );

            await client.whenSent("SAVEPOINT sp_1");
            await flushPendingWork();

            expect(client.statements).toEqual([
                "BEGIN",
                "SELECT 1",
                "SAVEPOINT sp_1",
            ]);
            expect(cleanUps).toEqual([]);

            savepointResult.resolve();

            expect(await scopeError).toBe(siblingFailure);
            expect(await nestedError).toBeInstanceOf(TransactionClosedError);
            expect(nestedCallbackRan).toBe(false);
            expect(client.statements).toEqual([
                "BEGIN",
                "SELECT 1",
                "SAVEPOINT sp_1",
                "ROLLBACK",
            ]);
            expectNoStatementAfterCleanUp();
        });

        describe("a NESTED scope whose callback finishes after the owner's callback failed", () => {
            // Starts a NESTED scope, fails a sibling while its callback waits,
            // and checks that the owner rolls back without waiting for it. The
            // callback then finishes with `finish`.
            async function finishNestedScopeAfterOwnerFailure(
                finish: () => void
            ): Promise<{ nested: Promise<void> }> {
                const nestedEntered = createDeferred();
                const nestedResume = createDeferred();
                const siblingFailure = new ScopeCallbackError();
                let nested!: Promise<void>;

                const scope = uow.scope(async () => {
                    await useClientInScope();
                    nested = uow.scope(
                        async () => {
                            nestedEntered.resolve();
                            await nestedResume.promise;
                            finish();
                        },
                        { propagation: Propagation.NESTED }
                    );
                    await Promise.all([
                        nested,
                        nestedEntered.promise.then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                });

                await expect(settleWithin(scope, "scope()")).rejects.toBe(
                    siblingFailure
                );
                expect(client.statements).toEqual([
                    "BEGIN",
                    "SELECT 1",
                    "SAVEPOINT sp_1",
                    "ROLLBACK",
                ]);
                expectCleanedUpOnceWithoutFailure();

                nestedResume.resolve();
                return { nested };
            }

            test("is refused its RELEASE SAVEPOINT when it succeeds", async () => {
                const { nested } = await finishNestedScopeAfterOwnerFailure(
                    () => {}
                );

                await expect(nested).rejects.toBeInstanceOf(
                    TransactionClosedError
                );
                expectNoStatementAfterCleanUp();
            });

            test("rejects with its own failure and reports the refused ROLLBACK TO SAVEPOINT when it fails", async () => {
                const reportedErrors = captureReportedErrors();
                const nestedFailure = new Error("nested callback failed");

                const { nested } = await finishNestedScopeAfterOwnerFailure(
                    () => {
                        throw nestedFailure;
                    }
                );

                await expect(nested).rejects.toBe(nestedFailure);
                expect(reportedErrors).toHaveBeenCalledWith(
                    "PostgresUnitOfWork could not roll back to a savepoint after a failure",
                    expect.any(TransactionClosedError),
                    nestedFailure
                );
                expectNoStatementAfterCleanUp();
            });
        });
    });

    describe("when the final ROLLBACK fails after a start that was in flight", () => {
        // Fails a sibling of the withClient() call that started the transaction
        // while `heldStatement` is held, with ROLLBACK set to fail, and
        // reports how the scope and that withClient() call settled.
        async function failSiblingWhileStartIsHeld(
            heldStatement: string,
            options: { isolationLevel?: IsolationLevel }
        ) {
            const heldResult = client.holdResultOf(heldStatement);
            const rollbackFailure = new Error("ROLLBACK failed");
            client.failOn("ROLLBACK", rollbackFailure);
            const reportedErrors = captureReportedErrors();
            const siblingFailure = new ScopeCallbackError();
            let afterRollbackCalled = false;
            let clientUseError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    const clientUse = useClientInScope();
                    clientUseError = captureRejection(clientUse);
                    await Promise.all([
                        clientUse,
                        client.whenSent(heldStatement).then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                }, options)
            );

            await client.whenSent(heldStatement);
            await flushPendingWork();
            heldResult.resolve();

            return {
                rollbackFailure,
                siblingFailure,
                reportedErrors,
                scopeError: await scopeError,
                clientUseError: await clientUseError,
                afterRollbackCalled,
            };
        }

        test("rejects with the sibling's error, runs afterRollback and reports the ROLLBACK failure when a sibling fails while BEGIN is held", async () => {
            const outcome = await failSiblingWhileStartIsHeld("BEGIN", {});

            expect(outcome.scopeError).toBe(outcome.siblingFailure);
            expect(outcome.afterRollbackCalled).toBe(true);
            expect(outcome.clientUseError).toBeInstanceOf(
                TransactionClosedError
            );
            expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
            expectCleanedUpOnceWithFailure(outcome.rollbackFailure);
            expectRollbackFailureReported(
                outcome.reportedErrors,
                outcome.rollbackFailure
            );
        });

        test("rejects with the sibling's error, runs afterRollback and reports the ROLLBACK failure when a sibling fails while SET TRANSACTION is held", async () => {
            const outcome = await failSiblingWhileStartIsHeld(
                SET_SERIALIZABLE,
                SERIALIZABLE
            );

            expect(outcome.scopeError).toBe(outcome.siblingFailure);
            expect(outcome.afterRollbackCalled).toBe(true);
            expect(outcome.clientUseError).toBeInstanceOf(
                TransactionClosedError
            );
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithFailure(outcome.rollbackFailure);
            expectRollbackFailureReported(
                outcome.reportedErrors,
                outcome.rollbackFailure
            );
        });

        test("rejects with the sibling's error and reports the ROLLBACK failure when the held SET TRANSACTION then fails", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            const isolationFailure = new Error("SET TRANSACTION failed");
            const rollbackFailure = new Error("ROLLBACK failed");
            client
                .failOn(SET_SERIALIZABLE, isolationFailure)
                .failOn("ROLLBACK", rollbackFailure);
            const siblingFailure = new ScopeCallbackError();
            const reportedErrors = captureReportedErrors();
            let afterRollbackCalled = false;
            let clientUseError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    const clientUse = useClientInScope();
                    clientUseError = captureRejection(clientUse);
                    await Promise.all([
                        clientUse,
                        client.whenSent(SET_SERIALIZABLE).then(() => {
                            throw siblingFailure;
                        }),
                    ]);
                }, SERIALIZABLE)
            );

            await client.whenSent(SET_SERIALIZABLE);
            await flushPendingWork();
            setResult.resolve();

            expect(await scopeError).toBe(siblingFailure);
            expect(afterRollbackCalled).toBe(true);
            expect(await clientUseError).toBe(isolationFailure);
            expectCleanedUpOnceWithFailure(rollbackFailure);
            expectRollbackFailureReported(reportedErrors, rollbackFailure);
        });

        test("a lazy scope still resolves and reports the ROLLBACK failure, and the withClient() it did not await is rejected as closed", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            const rollbackFailure = new Error("ROLLBACK failed");
            client.failOn("ROLLBACK", rollbackFailure);
            const reportedErrors = captureReportedErrors();
            let hookCalled = false;
            let clientUseError!: Promise<unknown>;

            const scope = uow.scope(async () => {
                uow.afterCommit(() => {
                    hookCalled = true;
                });
                uow.afterRollback(() => {
                    hookCalled = true;
                });
                clientUseError = captureRejection(useClientInScope());
                await client.whenSent(SET_SERIALIZABLE);
            }, SERIALIZABLE);

            await client.whenSent(SET_SERIALIZABLE);
            await flushPendingWork();
            setResult.resolve();

            await expect(scope).resolves.toBeUndefined();
            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(hookCalled).toBe(false);
            expectCleanedUpOnceWithFailure(rollbackFailure);
            expectRollbackFailureReported(reportedErrors, rollbackFailure);
        });

        test("a lazy scope still resolves and reports the ROLLBACK failure when the held SET TRANSACTION then fails", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            const isolationFailure = new Error("SET TRANSACTION failed");
            const rollbackFailure = new Error("ROLLBACK failed");
            client
                .failOn(SET_SERIALIZABLE, isolationFailure)
                .failOn("ROLLBACK", rollbackFailure);
            const reportedErrors = captureReportedErrors();
            let hookCalled = false;
            let clientUseError!: Promise<unknown>;

            const scope = uow.scope(async () => {
                uow.afterCommit(() => {
                    hookCalled = true;
                });
                uow.afterRollback(() => {
                    hookCalled = true;
                });
                clientUseError = captureRejection(useClientInScope());
                await client.whenSent(SET_SERIALIZABLE);
            }, SERIALIZABLE);

            await client.whenSent(SET_SERIALIZABLE);
            await flushPendingWork();
            setResult.resolve();

            await expect(scope).resolves.toBeUndefined();
            expect(await clientUseError).toBe(isolationFailure);
            expect(hookCalled).toBe(false);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithFailure(rollbackFailure);
            expect(reportedErrors).toHaveBeenCalledWith(
                expect.any(String),
                rollbackFailure
            );
        });
    });
});
