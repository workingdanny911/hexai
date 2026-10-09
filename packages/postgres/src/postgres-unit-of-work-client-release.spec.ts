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
const POOL_SIZE = 2;
const CONNECTION_TIMEOUT_MS = 2_000;
const SETTLE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 5;
const TERMINATE_TIMEOUT_MS = 5_000;
const BROKEN_CONNECTION_MESSAGE =
    "Client has encountered a connection error and is not queryable";
const CLOSED_CLIENT_MESSAGE = "Client was closed and is not queryable";

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

    interface FinalizationFailure {
        description: string;
        run(uow: DefaultPostgresUnitOfWork): Promise<unknown>;
        expectCallerError(error: unknown): void;
    }

    const finalizationFailures: FinalizationFailure[] = [
        {
            description: "COMMIT fails on a deferred constraint",
            run: (uow) =>
                uow.scope(() => uow.withClient(insertDuplicateDeferredRows)),
            expectCallerError: expectCommitConstraintViolation,
        },
        {
            description: "COMMIT fails on a terminated connection",
            run: (uow) =>
                uow.scope(() => uow.withClient(terminateConnection)),
            expectCallerError: expectBrokenConnectionError,
        },
        {
            description: "ROLLBACK fails on a terminated connection",
            run: (uow) =>
                uow.scope(async () => {
                    await uow.withClient(terminateConnection);
                    throw new ScopeCallbackError();
                }),
            expectCallerError: expectBrokenConnectionError,
        },
        {
            description: "the client was closed before ROLLBACK",
            run: (uow) =>
                uow.scope(async () => {
                    await uow.withClient((client) =>
                        (client as pg.Client).end()
                    );
                    throw new ScopeCallbackError();
                }),
            expectCallerError: expectScopeCallbackError,
        },
    ];

    describe("with a pg.Pool", () => {
        let pool: pg.Pool;
        let uow: DefaultPostgresUnitOfWork;

        function createPool(max: number): pg.Pool {
            const created = new pg.Pool({
                connectionString: databaseUrl,
                max,
                connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
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

        test("keeps the client of a caught start failure checked out until the scope ends", async () => {
            await uow.scope(
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
                    ).rejects.toMatchObject({ code: IN_FAILED_TRANSACTION });
                },
                { isolationLevel: "no such level" as IsolationLevel }
            );

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

        test("keeps another borrower's savepoint work when a rolled-back scope's NESTED callback fails late", async () => {
            await admin.query(`TRUNCATE ${COMMITTED_TABLE};`);
            const singleClientPool = createPool(1);
            const sharedUow = createPostgresUnitOfWork(singleClientPool);
            const siblingFailure = new ScopeCallbackError();
            const lateNestedFailure = new Error("late nested failure");
            const firstNestedEntered = createDeferred();
            const firstNestedResume = createDeferred();
            const secondInserted = createDeferred();
            const secondResume = createDeferred();
            let firstNestedError!: Promise<unknown>;

            const firstScopeError = await captureRejection(
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
            expect(firstScopeError).toBe(siblingFailure);

            // The second borrower gets the same connection and opens its own
            // sp_1, which the first scope's late savepoint rollback would hit.
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

            await secondInserted.promise;
            firstNestedResume.resolve();
            expect(await firstNestedError).toBe(lateNestedFailure);
            secondResume.resolve();

            await expect(secondScope).resolves.toBeUndefined();
            expect(await countCommittedRows()).toBe(1);
            await expectPoolToEnd(singleClientPool);
        });

        async function runSuccessfulScope(): Promise<void> {
            await uow.scope(() =>
                uow.withClient(async (client) => {
                    await client.query("SELECT 1;");
                })
            );
        }

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

        for (const { description, run, expectCallerError } of finalizationFailures) {
            describe(`when ${description}`, () => {
                test("rejects with the expected error and removes the client from the pool", async () => {
                    const error = await captureRejection(run(uow));

                    expectCallerError(error);
                    expect(poolCounts()).toEqual({
                        total: 0,
                        idle: 0,
                        waiting: 0,
                    });
                    await expectPoolToEnd();
                });

                test("keeps serving scopes after more failures than the pool size", async () => {
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

        test("ends the client after a commit", async () => {
            let usedClient!: pg.ClientBase;

            await uow.scope(() =>
                uow.withClient(async (client) => {
                    usedClient = client;
                })
            );

            await expect(usedClient.query("SELECT 1;")).rejects.toThrow(
                CLOSED_CLIENT_MESSAGE
            );
        });

        test("ends the client when COMMIT fails", async () => {
            let usedClient!: pg.ClientBase;

            const error = await captureRejection(
                uow.scope(() =>
                    uow.withClient(async (client) => {
                        usedClient = client;
                        client.on("error", ignoreDeliberateConnectionLoss);
                        await insertDuplicateDeferredRows(client);
                    })
                )
            );

            expectCommitConstraintViolation(error);
            await expect(usedClient.query("SELECT 1;")).rejects.toThrow(
                CLOSED_CLIENT_MESSAGE
            );
        });

        test("settles when ROLLBACK fails on a terminated connection", async () => {
            const error = await settleWithin(
                captureRejection(
                    uow.scope(async () => {
                        await uow.withClient(terminateConnection);
                        throw new ScopeCallbackError();
                    })
                ),
                "scope()"
            );

            expectBrokenConnectionError(error);
        });
    });
});

describe("PostgresUnitOfWork client cleanup on finalization", () => {
    class ScriptedClient {
        readonly statements: string[] = [];
        private readonly failures = new Map<string, unknown>();
        private readonly synchronousFailures = new Map<string, unknown>();
        private readonly heldResults = new Map<string, Deferred>();
        private readonly sent = new Map<string, Deferred>();

        failOn(statement: string, failure: unknown): this {
            this.failures.set(statement, failure);
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

        async connect(): Promise<void> {}

        query(statement: string): Promise<pg.QueryResult> {
            this.statements.push(statement);
            this.sentSignal(statement).resolve();
            if (this.synchronousFailures.has(statement)) {
                throw this.synchronousFailures.get(statement);
            }
            return this.respondTo(statement);
        }

        private async respondTo(statement: string): Promise<pg.QueryResult> {
            await this.heldResults.get(statement)?.promise;
            if (this.failures.has(statement)) {
                throw this.failures.get(statement);
            }
            return { command: statement, rowCount: 0, oid: 0, fields: [], rows: [] };
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

    test("rejects with a closed-client cleanup failure after ROLLBACK succeeds and skips afterRollback", async () => {
        cleanUpFailure = new Error(CLOSED_CLIENT_MESSAGE);
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
        ).rejects.toBe(cleanUpFailure);

        expect(afterRollbackCalled).toBe(false);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "ROLLBACK"]);
        expectCleanedUpOnceWithoutFailure();
    });

    // 0.15.0 released the client of a scope whose BEGIN failed while rolling
    // the scope back, and surfaced a cleanup failure from that release.
    test("rejects with the cleanup failure and skips afterRollback when a scope fails on BEGIN and cleanup fails", async () => {
        const beginFailure = new Error("BEGIN failed");
        client.failOn("BEGIN", beginFailure);
        cleanUpFailure = new Error("cleanup failed");
        let afterRollbackCalled = false;

        await expect(
            uow.scope(async () => {
                uow.afterRollback(() => {
                    afterRollbackCalled = true;
                });
                await useClientInScope();
            })
        ).rejects.toBe(cleanUpFailure);

        expect(afterRollbackCalled).toBe(false);
        expect(client.statements).toEqual(["BEGIN"]);
        expectCleanedUpOnceWithFailure(beginFailure);
    });

    // While SET TRANSACTION is held the start's ROLLBACK stands in for the
    // scope's own; 0.15.0 surfaced the cleanup failure after that ROLLBACK,
    // including one that reads like a closed client.
    test("rejects with the cleanup failure after the start's ROLLBACK when a sibling fails while SET TRANSACTION is held", async () => {
        const heldSet = client.holdResultOf(SET_SERIALIZABLE);
        cleanUpFailure = new Error(CLOSED_CLIENT_MESSAGE);
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

        expect(await scopeError).toBe(cleanUpFailure);
        expect(await clientUseError).toBe(cleanUpFailure);
        expect(afterRollbackCalled).toBe(false);
        expect(client.statements).toEqual([
            "BEGIN",
            SET_SERIALIZABLE,
            "ROLLBACK",
        ]);
        expectCleanedUpOnceWithoutFailure();
    });

    // 0.15.0 released the client at once when the scope rolled back during
    // BEGIN and surfaced a cleanup failure; the late BEGIN failure went to the
    // withClient() call.
    test("rejects with the cleanup failure when a sibling fails while BEGIN is held and BEGIN then fails", async () => {
        const heldBegin = client.holdResultOf("BEGIN");
        const beginFailure = new Error("BEGIN failed");
        client.failOn("BEGIN", beginFailure);
        cleanUpFailure = new Error("cleanup failed");
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

        expect(await scopeError).toBe(cleanUpFailure);
        expect(await clientUseError).toBe(beginFailure);
        expect(afterRollbackCalled).toBe(false);
        expect(client.statements).toEqual(["BEGIN"]);
        expectCleanedUpOnceWithFailure(beginFailure);
    });

    test("passes the COMMIT failure to cleanup and rethrows it", async () => {
        const commitFailure = new Error("COMMIT failed");
        client.failOn("COMMIT", commitFailure);

        await expect(uow.scope(useClientInScope)).rejects.toBe(commitFailure);

        expectCleanedUpOnceWithFailure(commitFailure);
    });

    test("does not run a withClient() callback the scope did not await once a synchronous COMMIT failure released the client", async () => {
        const commitFailure = new Error("COMMIT failed");
        client.failSynchronouslyOn("COMMIT", commitFailure);
        let lateCallbackRan = false;
        let lateUseError!: Promise<unknown>;

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                lateUseError = captureRejection(
                    uow.withClient(async (c) => {
                        lateCallbackRan = true;
                        await c.query("SELECT 2");
                    })
                );
            })
        ).rejects.toBe(commitFailure);

        expect(await lateUseError).toBeInstanceOf(TransactionClosedError);
        expect(lateCallbackRan).toBe(false);
        expect(client.statements).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
        expectCleanedUpOnceWithFailure(commitFailure);
        expectNoStatementAfterCleanUp();
    });

    test("passes the ROLLBACK failure to cleanup and rethrows it", async () => {
        const rollbackFailure = new Error("ROLLBACK failed");
        client.failOn("ROLLBACK", rollbackFailure);

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                throw new ScopeCallbackError();
            })
        ).rejects.toBe(rollbackFailure);

        expectCleanedUpOnceWithFailure(rollbackFailure);
    });

    test("passes the closed-client failure to cleanup and rethrows the callback error", async () => {
        const closedClientFailure = new Error(CLOSED_CLIENT_MESSAGE);
        const callbackFailure = new ScopeCallbackError();
        client.failOn("ROLLBACK", closedClientFailure);

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                throw callbackFailure;
            })
        ).rejects.toBe(callbackFailure);

        expectCleanedUpOnceWithFailure(closedClientFailure);
    });

    test("passes the ROLLBACK failure to cleanup when a beforeCommit hook fails", async () => {
        const rollbackFailure = new Error("ROLLBACK failed");
        client.failOn("ROLLBACK", rollbackFailure);

        await expect(
            uow.scope(async () => {
                await useClientInScope();
                uow.beforeCommit(() => {
                    throw new Error("beforeCommit hook failed");
                });
            })
        ).rejects.toBe(rollbackFailure);

        expectCleanedUpOnceWithFailure(rollbackFailure);
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

    describe("when the transaction cannot start", () => {
        test("passes the BEGIN failure to cleanup when wrap() fails to start", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);

            await expect(uow.wrap(async () => {})).rejects.toBe(beginFailure);

            expectCleanedUpOnceWithFailure(beginFailure);
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

        test("passes the BEGIN failure to cleanup when the scope swallows it", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);

            await uow.scope(async () => {
                await expect(useClientInScope()).rejects.toBe(beginFailure);
            });

            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("rolls back and cleans up when wrap() cannot set the isolation level", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);

            await expect(
                uow.wrap(async () => {}, SERIALIZABLE)
            ).rejects.toBe(isolationFailure);

            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithoutFailure();
        });

        test("keeps the client until the scope ends after it swallows a BEGIN failure", async () => {
            const beginFailure = new Error("BEGIN failed");
            client.failOn("BEGIN", beginFailure);

            await uow.scope(async () => {
                await expect(useClientInScope()).rejects.toBe(beginFailure);

                expect(uow.getClient()).toBe(client);
                await expect(useClientInScope()).rejects.toBe(beginFailure);
                expect(cleanUps).toEqual([]);
            });

            expect(client.statements).toEqual(["BEGIN"]);
            expectCleanedUpOnceWithFailure(beginFailure);
        });

        test("commits as before when the scope swallows a SET TRANSACTION failure", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);
            let afterCommitCalled = false;

            await uow.scope(async () => {
                uow.afterCommit(() => {
                    afterCommitCalled = true;
                });
                await expect(useClientInScope()).rejects.toBe(
                    isolationFailure
                );

                expect(uow.getClient()).toBe(client);
                await expect(useClientInScope()).rejects.toBe(
                    isolationFailure
                );
                expect(cleanUps).toEqual([]);
            }, SERIALIZABLE);

            expect(afterCommitCalled).toBe(true);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "COMMIT",
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

        test("rethrows the start failure when the follow-up ROLLBACK also fails", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            const rollbackFailure = new Error("ROLLBACK failed");
            client
                .failOn(SET_SERIALIZABLE, isolationFailure)
                .failOn("ROLLBACK", rollbackFailure);
            const reportedErrors = captureReportedErrors();

            await expect(
                uow.wrap(async () => {}, SERIALIZABLE)
            ).rejects.toBe(isolationFailure);

            expectCleanedUpOnceWithFailure(rollbackFailure);
            expect(reportedErrors).toHaveBeenCalledWith(
                expect.any(String),
                rollbackFailure
            );
        });

        test("rejects a scope with the ROLLBACK failure and skips afterRollback when the ROLLBACK after a SET TRANSACTION failure also fails", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            const rollbackFailure = new Error("ROLLBACK failed");
            client
                .failOn(SET_SERIALIZABLE, isolationFailure)
                .failOn("ROLLBACK", rollbackFailure);
            let afterRollbackCalled = false;

            await expect(
                uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    await useClientInScope();
                }, SERIALIZABLE)
            ).rejects.toBe(rollbackFailure);

            expect(afterRollbackCalled).toBe(false);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithFailure(rollbackFailure);
        });

        test("rethrows the start failure when cleanup after the follow-up ROLLBACK fails", async () => {
            const isolationFailure = new Error("SET TRANSACTION failed");
            client.failOn(SET_SERIALIZABLE, isolationFailure);
            cleanUpFailure = new Error("cleanup failed");
            const reportedErrors = captureReportedErrors();

            await expect(
                uow.wrap(async () => {}, SERIALIZABLE)
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
            expect(cleanUps).toEqual([]);

            acquisition.resolve();

            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
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

            expect(cleanUps).toEqual([]);

            acquisition.resolve();

            expect(await clientUseError).toBeInstanceOf(TransactionClosedError);
            expect(client.statements).toEqual([]);
            expectCleanedUpOnceWithoutFailure();
        });
    });

    describe("when nested work reaches the client after the transaction closed", () => {
        const NESTED_STATEMENT = "INSERT nested";

        let nestedCallbackRan: boolean;

        beforeEach(() => {
            nestedCallbackRan = false;
        });

        const nestedEntries: Array<{
            description: string;
            enter(): Promise<unknown>;
        }> = [
            {
                description: "a nested wrap()",
                enter: () =>
                    uow.wrap(async (c) => {
                        nestedCallbackRan = true;
                        await c.query(NESTED_STATEMENT);
                    }),
            },
            {
                description: "a NESTED scope",
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

        for (const { description, enter } of nestedEntries) {
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
                    expect(await nestedError).toBeInstanceOf(
                        TransactionClosedError
                    );
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
                    acquisition.resolve();

                    expect(scopeError).toBe(siblingFailure);
                    expect(await nestedError).toBeInstanceOf(
                        TransactionClosedError
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

                    expect(await nestedError).toBeInstanceOf(
                        TransactionClosedError
                    );
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

        test("a NESTED scope is rejected when the transaction closes while SAVEPOINT is held", async () => {
            const savepointResult = client.holdResultOf("SAVEPOINT sp_1");
            const siblingFailure = new ScopeCallbackError();
            let nestedError!: Promise<unknown>;

            const scopeError = captureRejection(
                uow.scope(async () => {
                    await useClientInScope();
                    const nested = nestedEntries[1].enter();
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

        describe("a NESTED scope whose callback finishes after the root rolled back", () => {
            // Starts a NESTED scope, fails a sibling while its callback waits,
            // and lets the root roll back and release the client before the
            // callback finishes with `finish`.
            async function finishNestedScopeAfterRootRollback(
                finish: () => void
            ): Promise<unknown> {
                const nestedEntered = createDeferred();
                const nestedResume = createDeferred();
                const siblingFailure = new ScopeCallbackError();
                let nestedError!: Promise<unknown>;

                const scopeError = await captureRejection(
                    uow.scope(async () => {
                        await useClientInScope();
                        const nested = uow.scope(
                            async () => {
                                nestedEntered.resolve();
                                await nestedResume.promise;
                                finish();
                            },
                            { propagation: Propagation.NESTED }
                        );
                        nestedError = captureRejection(nested);
                        await Promise.all([
                            nested,
                            nestedEntered.promise.then(() => {
                                throw siblingFailure;
                            }),
                        ]);
                    })
                );

                expect(scopeError).toBe(siblingFailure);
                expect(cleanUps).toHaveLength(1);

                nestedResume.resolve();
                return nestedError;
            }

            const statementsBeforeRelease = [
                "BEGIN",
                "SELECT 1",
                "SAVEPOINT sp_1",
                "ROLLBACK",
            ];

            test("rejects with TransactionClosedError and sends no RELEASE SAVEPOINT when it succeeds", async () => {
                const nestedError = await finishNestedScopeAfterRootRollback(
                    () => {}
                );

                expect(nestedError).toBeInstanceOf(TransactionClosedError);
                expect(client.statements).toEqual(statementsBeforeRelease);
                expectNoStatementAfterCleanUp();
            });

            test("rethrows its own error and sends no ROLLBACK TO SAVEPOINT when it fails", async () => {
                const nestedFailure = new Error("nested callback failed");

                const nestedError = await finishNestedScopeAfterRootRollback(
                    () => {
                        throw nestedFailure;
                    }
                );

                expect(nestedError).toBe(nestedFailure);
                expect(client.statements).toEqual(statementsBeforeRelease);
                expectNoStatementAfterCleanUp();
            });
        });
    });

    describe("when the ROLLBACK the start sends for a closed transaction fails", () => {
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
                scopeError: await scopeError,
                clientUseError: await clientUseError,
                afterRollbackCalled,
            };
        }

        // BEGIN had not completed when the scope began to roll back, so, as
        // in 0.15.0, the scope sends no ROLLBACK of its own and keeps the
        // callback's error.
        test("rejects with the sibling's error and runs afterRollback when a sibling fails while BEGIN is held", async () => {
            const outcome = await failSiblingWhileStartIsHeld("BEGIN", {});

            expect(outcome.scopeError).toBe(outcome.siblingFailure);
            expect(outcome.afterRollbackCalled).toBe(true);
            expect(outcome.clientUseError).toBe(outcome.rollbackFailure);
            expect(client.statements).toEqual(["BEGIN", "ROLLBACK"]);
            expectCleanedUpOnceWithFailure(outcome.rollbackFailure);
        });

        // BEGIN had completed when the scope began to roll back, so the
        // start's ROLLBACK stands in for the scope's own, whose failure
        // 0.15.0 surfaced.
        test("rejects with the ROLLBACK failure and skips afterRollback when a sibling fails while SET TRANSACTION is held", async () => {
            const outcome = await failSiblingWhileStartIsHeld(
                SET_SERIALIZABLE,
                SERIALIZABLE
            );

            expect(outcome.scopeError).toBe(outcome.rollbackFailure);
            expect(outcome.afterRollbackCalled).toBe(false);
            expect(outcome.clientUseError).toBe(outcome.rollbackFailure);
            expect(client.statements).toEqual([
                "BEGIN",
                SET_SERIALIZABLE,
                "ROLLBACK",
            ]);
            expectCleanedUpOnceWithFailure(outcome.rollbackFailure);
        });

        test("rejects with the ROLLBACK failure when the held SET TRANSACTION then fails", async () => {
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

            expect(await scopeError).toBe(rollbackFailure);
            expect(afterRollbackCalled).toBe(false);
            expect(await clientUseError).toBe(isolationFailure);
            expectCleanedUpOnceWithFailure(rollbackFailure);
            expect(reportedErrors).not.toHaveBeenCalled();
        });

        test("a lazy scope still resolves and the withClient() it did not await receives the ROLLBACK failure", async () => {
            const setResult = client.holdResultOf(SET_SERIALIZABLE);
            const rollbackFailure = new Error("ROLLBACK failed");
            client.failOn("ROLLBACK", rollbackFailure);
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
            expect(await clientUseError).toBe(rollbackFailure);
            expect(hookCalled).toBe(false);
            expectCleanedUpOnceWithFailure(rollbackFailure);
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
