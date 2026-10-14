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
import {
    captureRejection,
    createDeferred,
    flushPendingWork,
    ScopeCallbackError,
    settleWithin,
    waitUntil,
} from "./test-fixtures/async.fixtures.js";

const DATABASE = "test_hexai__uow_client_release";
const DEFERRED_TABLE = "deferred_unique";
const COMMITTED_TABLE = "committed_rows";
const UNIQUE_VIOLATION = "23505";
const SYNTAX_ERROR = "42601";
const IN_FAILED_TRANSACTION = "25P02";
const DIVISION_BY_ZERO = "22012";
const POOL_SIZE = 2;
const CONNECTION_TIMEOUT_MS = 2_000;
const TERMINATE_TIMEOUT_MS = 5_000;
const BROKEN_CONNECTION_MESSAGE =
    "Client has encountered a connection error and is not queryable";

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
