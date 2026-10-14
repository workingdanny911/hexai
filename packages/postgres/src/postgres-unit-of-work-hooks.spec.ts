import { describe, expect, test } from "vitest";

import { Propagation } from "@hexaijs/core";
import { TransactionClosedError } from "./postgres-unit-of-work.js";
import {
    captureRejection,
    createDeferred,
} from "./test-fixtures/async.fixtures.js";
import {
    areDistinctTransactions,
    areSameTransaction,
    captureSyncError,
    expectNoActiveTransaction,
    expectTransactionAborted,
    getTransactionId,
    useUnitOfWorkTestContext,
} from "./test-fixtures/unit-of-work-database.fixtures.js";

const DATABASE = "test_hexai__uow_hooks";

describe("PostgresUnitOfWork", () => {
    const {
        uow,
        insertRecord,
        expectRecordExists,
        expectRecordNotExists,
        expectRecordCount,
    } = useUnitOfWorkTestContext(DATABASE);

    describe("transaction lifecycle hooks", () => {
        describe("beforeCommit", () => {
            test("executes before COMMIT and can access DB", async () => {
                await uow.scope(async () => {
                    uow.beforeCommit(async () => {
                        await uow.withClient(async (client) => {
                            await insertRecord(client, 99);
                        });
                    });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                await expectRecordExists(1);
                await expectRecordExists(99);
            });

            test("executes in registration order", async () => {
                const order: number[] = [];

                await uow.scope(async () => {
                    uow.beforeCommit(() => { order.push(1); });
                    uow.beforeCommit(() => { order.push(2); });
                    uow.beforeCommit(() => { order.push(3); });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(order).toEqual([1, 2, 3]);
            });

            test("runs drain-phase hooks after main hooks for the current transaction", async () => {
                const order: string[] = [];

                await uow.scope(async () => {
                    uow.beforeCommit(() => { order.push("drain"); }, {
                        phase: "drain",
                    });
                    uow.beforeCommit(() => { order.push("main"); });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(order).toEqual(["main", "drain"]);
                await expectRecordExists(1);
            });

            test("allows a main hook to register a drain hook on the current transaction", async () => {
                const order: string[] = [];

                await uow.scope(async () => {
                    uow.beforeCommit(() => {
                        order.push("main");
                        uow.beforeCommit(() => { order.push("drain"); }, {
                            phase: "drain",
                        });
                    });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(order).toEqual(["main", "drain"]);
                await expectRecordExists(1);
            });

            test("does not re-enter finalization when a hook opens a scope", async () => {
                let hookEntries = 0;
                let commits = 0;
                const unsubscribe = uow.onEveryCommit(() => {
                    commits++;
                });

                await uow.scope(async () => {
                    uow.beforeCommit(async () => {
                        hookEntries++;
                        await uow.scope(() =>
                            uow.withClient((client) => insertRecord(client, 2))
                        );
                    });
                    await uow.withClient((client) => insertRecord(client, 1));
                });
                unsubscribe();

                expect(hookEntries).toBe(1);
                expect(commits).toBe(1);
                await expectRecordExists(1);
                await expectRecordExists(2);
            });

            test("rolls back instead of committing when a scope opened in a hook fails", async () => {
                const scopeFailure = new Error("scope in hook failed");
                let afterRollbackCalled = false;

                const outcome = uow.scope(async () => {
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    uow.beforeCommit(async () => {
                        await uow
                            .scope(async () => {
                                await uow.withClient((client) =>
                                    insertRecord(client, 2)
                                );
                                throw scopeFailure;
                            })
                            .catch(() => undefined);
                    });
                    await uow.withClient((client) => insertRecord(client, 1));
                });

                await expectTransactionAborted(outcome, scopeFailure);
                expect(afterRollbackCalled).toBe(true);
                await expectRecordCount(0);
            });

            test("rolls back instead of committing when a hook prevents the commit", async () => {
                let afterCommitCalled = false;
                let afterRollbackCalled = false;

                const result = await uow.scope(async () => {
                    uow.afterCommit(() => {
                        afterCommitCalled = true;
                    });
                    uow.afterRollback(() => {
                        afterRollbackCalled = true;
                    });
                    uow.beforeCommit(() => {
                        uow.preventCommit("prevented by a hook");
                    });
                    await uow.withClient((client) => insertRecord(client, 1));
                    return 42;
                });

                expect(result).toBe(42);
                expect(afterCommitCalled).toBe(false);
                expect(afterRollbackCalled).toBe(true);
                await expectRecordNotExists(1);
            });

            test("rejects work from outside the beforeCommit hooks while committing", async () => {
                const hookStarted = createDeferred();
                let outsideAttempts!: Promise<unknown[]>;
                let outsideScopeRan = false;

                await uow.scope(async () => {
                    outsideAttempts = hookStarted.promise.then(() =>
                        Promise.all([
                            captureRejection(
                                uow.withClient((client) =>
                                    insertRecord(client, 3)
                                )
                            ),
                            captureRejection(
                                uow.scope(async () => {
                                    outsideScopeRan = true;
                                })
                            ),
                            captureSyncError(() => uow.afterCommit(() => {})),
                        ])
                    );
                    uow.beforeCommit(async () => {
                        hookStarted.resolve();
                        await outsideAttempts;
                        await uow.withClient((client) =>
                            insertRecord(client, 2)
                        );
                    });
                    await uow.withClient((client) => insertRecord(client, 1));
                });

                const outsideErrors = await outsideAttempts;
                expect(outsideErrors).toHaveLength(3);
                for (const error of outsideErrors) {
                    expect(error).toBeInstanceOf(TransactionClosedError);
                }
                expect(outsideScopeRan).toBe(false);
                await expectRecordExists(1);
                await expectRecordExists(2);
                await expectRecordNotExists(3);
            });

            test("triggers rollback when hook throws", async () => {
                try {
                    await uow.scope(async () => {
                        uow.beforeCommit(() => {
                            throw new Error("hook failure");
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch (e) {
                    expect((e as Error).message).toBe("hook failure");
                }

                await expectRecordNotExists(1);
            });
        });

        describe("afterCommit", () => {
            test("executes after successful commit", async () => {
                let called = false;

                await uow.scope(async () => {
                    uow.afterCommit(() => { called = true; });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(called).toBe(true);
                await expectRecordExists(1);
            });

            test("does not execute when scope fails", async () => {
                let called = false;

                try {
                    await uow.scope(async () => {
                        uow.afterCommit(() => { called = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(false);
            });

            test("does not execute when beforeCommit fails", async () => {
                let afterCommitCalled = false;

                try {
                    await uow.scope(async () => {
                        uow.beforeCommit(() => {
                            throw new Error("beforeCommit failure");
                        });
                        uow.afterCommit(() => { afterCommitCalled = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch {
                    // expected
                }

                expect(afterCommitCalled).toBe(false);
            });
        });

        describe("afterRollback", () => {
            test("executes after rollback on scope failure", async () => {
                let called = false;

                try {
                    await uow.scope(async () => {
                        uow.afterRollback(() => { called = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(true);
            });

            test("executes after rollback caused by beforeCommit failure", async () => {
                let afterRollbackCalled = false;

                try {
                    await uow.scope(async () => {
                        uow.beforeCommit(() => {
                            throw new Error("hook failure");
                        });
                        uow.afterRollback(() => { afterRollbackCalled = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch {
                    // expected
                }

                expect(afterRollbackCalled).toBe(true);
            });

            test("does not execute on successful commit", async () => {
                let called = false;

                await uow.scope(async () => {
                    uow.afterRollback(() => { called = true; });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(called).toBe(false);
            });
        });

        describe("transaction context", () => {
            test("keeps beforeCommit hooks inside the active transaction", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });

                    uow.beforeCommit(async () => {
                        await uow.withClient(async (client) => {
                            txids.push(await getTransactionId(client));
                        });

                        uow.beforeCommit(async () => {
                            await uow.withClient(async (client) => {
                                txids.push(await getTransactionId(client));
                            });
                        }, { phase: "drain" });
                    });
                });

                expect(areSameTransaction(...txids)).toBe(true);
            });

            test("runs afterCommit outside the completed transaction context", async () => {
                const txids: string[] = [];
                let directClientError: unknown;

                await uow.scope(async () => {
                    uow.afterCommit(async () => {
                        directClientError = captureSyncError(() =>
                            uow.getClient()
                        );

                        await uow.withClient(async (client) => {
                            txids.push(await getTransactionId(client));
                            await insertRecord(client, 2);
                        });
                    });

                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                        await insertRecord(client, 1);
                    });
                });

                expectNoActiveTransaction(directClientError);
                expect(areDistinctTransactions(...txids)).toBe(true);
                await expectRecordExists(1);
                await expectRecordExists(2);
            });

            test("runs afterRollback outside the completed transaction context", async () => {
                const scopeFailure = new Error("scope failure");
                const txids: string[] = [];
                let directClientError: unknown;

                await expect(
                    uow.scope(async () => {
                        uow.afterRollback(async () => {
                            directClientError = captureSyncError(() =>
                                uow.getClient()
                            );

                            await uow.withClient(async (client) => {
                                txids.push(await getTransactionId(client));
                                await insertRecord(client, 2);
                            });
                        });

                        await uow.withClient(async (client) => {
                            txids.push(await getTransactionId(client));
                            await insertRecord(client, 1);
                        });
                        throw scopeFailure;
                    })
                ).rejects.toBe(scopeFailure);

                expectNoActiveTransaction(directClientError);
                expect(areDistinctTransactions(...txids)).toBe(true);
                await expectRecordNotExists(1);
                await expectRecordExists(2);
            });

            test("runs afterRollback outside the prevented transaction context", async () => {
                const txids: string[] = [];

                const result = await uow.scope(async () => {
                    uow.afterRollback(async () => {
                        await uow.withClient(async (client) => {
                            txids.push(await getTransactionId(client));
                            await insertRecord(client, 2);
                        });
                    });

                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                        await insertRecord(client, 1);
                    });
                    uow.preventCommit();

                    return "handled";
                });

                expect(result).toBe("handled");
                expect(areDistinctTransactions(...txids)).toBe(true);
                await expectRecordNotExists(1);
                await expectRecordExists(2);
            });

            test("rejects leaked async work that uses a closed transaction context", async () => {
                const gate = createDeferred();
                let leakedClientUse!: Promise<void>;

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });

                    leakedClientUse = gate.promise.then(() =>
                        uow.withClient(async (client) => {
                            await insertRecord(client, 2);
                        })
                    );
                });

                gate.resolve();

                await expect(leakedClientUse).rejects.toBeInstanceOf(
                    TransactionClosedError
                );
                await expectRecordExists(1);
                await expectRecordNotExists(2);
            });

            test("rejects leaked async work after a lazy no-op scope", async () => {
                const gate = createDeferred();
                let leakedClientUse!: Promise<void>;

                await uow.scope(async () => {
                    leakedClientUse = gate.promise.then(() =>
                        uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        })
                    );
                });

                gate.resolve();

                await expect(leakedClientUse).rejects.toBeInstanceOf(
                    TransactionClosedError
                );
                await expectRecordNotExists(1);
            });

            test("rolls back a leaked microtask that races lazy no-op finalization", async () => {
                let leakedClientUse!: Promise<void>;

                await uow.scope(async () => {
                    leakedClientUse = Promise.resolve().then(() =>
                        uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        })
                    );
                });

                await expect(leakedClientUse).rejects.toBeInstanceOf(
                    TransactionClosedError
                );
                await expectRecordNotExists(1);
            });
        });

        describe("hook registration outside scope", () => {
            test("throws when registering beforeCommit outside scope", () => {
                expect(() => uow.beforeCommit(() => {})).toThrow(
                    /outside of a transaction scope/
                );
            });

            test("throws when registering afterCommit outside scope", () => {
                expect(() => uow.afterCommit(() => {})).toThrow(
                    /outside of a transaction scope/
                );
            });

            test("throws when registering afterRollback outside scope", () => {
                expect(() => uow.afterRollback(() => {})).toThrow(
                    /outside of a transaction scope/
                );
            });
        });

        describe("lazy init edge case", () => {
            test("hooks do not execute when no DB operation occurs", async () => {
                let beforeCalled = false;
                let afterCalled = false;

                await uow.scope(async () => {
                    uow.beforeCommit(() => { beforeCalled = true; });
                    uow.afterCommit(() => { afterCalled = true; });
                });

                expect(beforeCalled).toBe(false);
                expect(afterCalled).toBe(false);
            });
        });

        describe("nesting", () => {
            test("hooks registered in NESTED scope execute at root commit", async () => {
                let hookCalled = false;

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });

                    await uow.scope(
                        async () => {
                            uow.afterCommit(() => { hookCalled = true; });

                            await uow.withClient(async (client) => {
                                await insertRecord(client, 2);
                            });
                        },
                        { propagation: Propagation.NESTED }
                    );
                });

                expect(hookCalled).toBe(true);
                await expectRecordExists(1);
                await expectRecordExists(2);
            });
        });

        describe("best-effort execution", () => {
            test("afterCommit runs all hooks even when one throws", async () => {
                let secondHookCalled = false;

                await expect(
                    uow.scope(async () => {
                        uow.afterCommit(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterCommit(() => { secondHookCalled = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    })
                ).rejects.toBeInstanceOf(AggregateError);

                expect(secondHookCalled).toBe(true);
                await expectRecordExists(1);
            });

            test("afterRollback runs all hooks even when one throws", async () => {
                let secondHookCalled = false;

                await expect(
                    uow.scope(async () => {
                        uow.afterRollback(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterRollback(() => { secondHookCalled = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        throw new Error("scope failure");
                    })
                ).rejects.toBeInstanceOf(AggregateError);

                expect(secondHookCalled).toBe(true);
                await expectRecordNotExists(1);
            });
        });

        describe("error cause chaining", () => {
            test("scope failure is preserved as cause when afterRollback hook fails", async () => {
                const scopeError = new Error("scope failure");

                try {
                    await uow.scope(async () => {
                        uow.afterRollback(() => {
                            throw new Error("hook failure");
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        throw scopeError;
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBe(scopeError);
                }
            });

            test("beforeCommit failure is preserved as cause when afterRollback hook fails", async () => {
                const beforeCommitError = new Error("beforeCommit failure");

                try {
                    await uow.scope(async () => {
                        uow.beforeCommit(() => { throw beforeCommitError; });
                        uow.afterRollback(() => {
                            throw new Error("hook failure");
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBe(beforeCommitError);
                }
            });

            test("afterCommit failure has no cause on success path", async () => {
                try {
                    await uow.scope(async () => {
                        uow.afterCommit(() => {
                            throw new Error("hook failure");
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBeUndefined();
                }
            });
        });
    });
});
