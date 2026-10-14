import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { IsolationLevel } from "./types.js";
import {
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
    TransactionClosedError,
} from "./postgres-unit-of-work.js";
import {
    captureRejection,
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
        expectRollbackFailureReported,
    } = scriptedUnitOfWorkChecks(() => ({
        client,
        uow,
        cleanUps,
        cleanUpFailure,
    }));

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
