import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Propagation } from "@hexaijs/core";
import {
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
    TransactionClosedError,
} from "./postgres-unit-of-work.js";
import {
    captureRejection,
    createDeferred,
    flushPendingWork,
    ScopeCallbackError,
    settleWithin,
    waitUntil,
} from "./test-fixtures/async.fixtures.js";
import {
    type CleanUpCall,
    createScriptedUnitOfWork,
    ScriptedClient,
    scriptedUnitOfWorkChecks,
    SERIALIZABLE,
    SET_SERIALIZABLE,
} from "./test-fixtures/scripted-client.fixtures.js";

describe("PostgresUnitOfWork client cleanup on finalization", () => {
    let client: ScriptedClient;
    let cleanUps: CleanUpCall[];
    let cleanUpFailure: unknown;
    let uow: DefaultPostgresUnitOfWork;

    beforeEach(() => {
        client = new ScriptedClient();
        cleanUps = [];
        cleanUpFailure = undefined;
        uow = createScriptedUnitOfWork(client, {
            cleanUps,
            cleanUpFailure: () => cleanUpFailure,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        // The unit of work never hands the connection a statement while
        // another one is still in flight.
        expect(client.overlappingStatements).toEqual([]);
    });

    const {
        holdClientAcquisition,
        captureReportedErrors,
        expectCleanedUpOnceWithoutFailure,
        expectCleanedUpOnceWithFailure,
        useClientInScope,
        expectNoStatementAfterCleanUp,
        expectCleanUpFailureReported,
        expectRollbackFailureReported,
    } = scriptedUnitOfWorkChecks(() => ({
        client,
        uow,
        cleanUps,
        cleanUpFailure,
    }));

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
});
