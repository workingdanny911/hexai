import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import {
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
    TransactionClosedError,
} from "./postgres-unit-of-work.js";
import {
    captureRejection,
    captureThrown,
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
        useClientInScope,
        expectNoStatementAfterCleanUp,
    } = scriptedUnitOfWorkChecks(() => ({
        client,
        uow,
        cleanUps,
        cleanUpFailure,
    }));

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
});
