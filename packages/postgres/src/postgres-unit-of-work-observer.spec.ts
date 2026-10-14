import { describe, expect, test, vi } from "vitest";

import { Propagation } from "@hexaijs/core";
import {
    areDistinctTransactions,
    captureSyncError,
    expectNoActiveTransaction,
    getTransactionId,
    useUnitOfWorkTestContext,
} from "./test-fixtures/unit-of-work-database.fixtures.js";

const DATABASE = "test_hexai__uow_observer";

describe("PostgresUnitOfWork", () => {
    const {
        uow,
        insertRecord,
        expectRecordExists,
        expectRecordNotExists,
        expectRecordCount,
    } = useUnitOfWorkTestContext(DATABASE);

    describe("onEveryCommit observer", () => {
        test("runs once after a successful root commit and after afterCommit hooks", async () => {
            const order: string[] = [];
            const unsubscribe = uow.onEveryCommit(() => {
                order.push("observer");
            });

            try {
                await uow.scope(async () => {
                    uow.afterCommit(() => { order.push("afterCommit"); });

                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                expect(order).toEqual(["afterCommit", "observer"]);
                await expectRecordExists(1);
            } finally {
                unsubscribe();
            }
        });

        test("does not run on rollback", async () => {
            let called = false;
            const unsubscribe = uow.onEveryCommit(() => {
                called = true;
            });

            try {
                await expect(
                    uow.scope(async () => {
                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        throw new Error("scope failure");
                    })
                ).rejects.toThrow("scope failure");

                expect(called).toBe(false);
                await expectRecordNotExists(1);
            } finally {
                unsubscribe();
            }
        });

        test("does not run when beforeCommit fails", async () => {
            let called = false;
            const unsubscribe = uow.onEveryCommit(() => {
                called = true;
            });

            try {
                await expect(
                    uow.scope(async () => {
                        uow.beforeCommit(() => {
                            throw new Error("beforeCommit failure");
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    })
                ).rejects.toThrow("beforeCommit failure");

                expect(called).toBe(false);
                await expectRecordNotExists(1);
            } finally {
                unsubscribe();
            }
        });

        test("does not run when commit is prevented", async () => {
            let called = false;
            const unsubscribe = uow.onEveryCommit(() => {
                called = true;
            });

            try {
                const result = await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                    uow.preventCommit();
                    return "handled";
                });

                expect(result).toBe("handled");
                expect(called).toBe(false);
                await expectRecordNotExists(1);
            } finally {
                unsubscribe();
            }
        });

        test("does not run for a lazy no-op scope", async () => {
            let called = false;
            const unsubscribe = uow.onEveryCommit(() => {
                called = true;
            });

            try {
                await uow.scope(async () => {});

                expect(called).toBe(false);
                await expectRecordCount(0);
            } finally {
                unsubscribe();
            }
        });

        test("does not run when a nested savepoint is released before root commit", async () => {
            const order: string[] = [];
            const unsubscribe = uow.onEveryCommit(() => {
                order.push("observer");
            });

            try {
                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });

                    await uow.scope(
                        async () => {
                            await uow.withClient(async (client) => {
                                await insertRecord(client, 2);
                            });
                        },
                        { propagation: Propagation.NESTED }
                    );

                    order.push("after savepoint release");
                    expect(order).toEqual(["after savepoint release"]);
                });

                expect(order).toEqual([
                    "after savepoint release",
                    "observer",
                ]);
                await expectRecordCount(2);
            } finally {
                unsubscribe();
            }
        });

        test("runs outside the transaction context while withClient remains usable", async () => {
            const txids: string[] = [];
            let directClientError: unknown;
            const unsubscribe = uow.onEveryCommit(async () => {
                directClientError = captureSyncError(() => uow.getClient());

                await uow.withClient(async (client) => {
                    txids.push(await getTransactionId(client));
                    await insertRecord(client, 2);
                });
            });

            try {
                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                        await insertRecord(client, 1);
                    });
                });

                expectNoActiveTransaction(directClientError);
                expect(areDistinctTransactions(...txids)).toBe(true);
                await expectRecordExists(1);
                await expectRecordExists(2);
            } finally {
                unsubscribe();
            }
        });

        test("logs observer errors without blocking later observers or changing the scope result", async () => {
            const observerFailure = new Error("observer failure");
            const errorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});
            let secondObserverCalled = false;
            const unsubscribeFailing = uow.onEveryCommit(() => {
                throw observerFailure;
            });
            const unsubscribeSecond = uow.onEveryCommit(() => {
                secondObserverCalled = true;
            });

            try {
                const result = await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                    return "ok";
                });

                expect(result).toBe("ok");
                expect(secondObserverCalled).toBe(true);
                expect(errorSpy).toHaveBeenCalledWith(
                    "PostgresUnitOfWork onEveryCommit observer failed",
                    observerFailure
                );
                await expectRecordExists(1);
            } finally {
                unsubscribeFailing();
                unsubscribeSecond();
                errorSpy.mockRestore();
            }
        });

        test("still runs when afterCommit fails and preserves the afterCommit error", async () => {
            const afterCommitFailure = new Error("afterCommit failure");
            let observerCalled = false;
            const unsubscribe = uow.onEveryCommit(() => {
                observerCalled = true;
            });

            try {
                let error: unknown;
                try {
                    await uow.scope(async () => {
                        uow.afterCommit(() => {
                            throw afterCommitFailure;
                        });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                    });
                } catch (e) {
                    error = e;
                }

                expect(error).toBeInstanceOf(AggregateError);
                expect((error as AggregateError).errors).toEqual([
                    afterCommitFailure,
                ]);
                expect(observerCalled).toBe(true);
                await expectRecordExists(1);
            } finally {
                unsubscribe();
            }
        });

        test("unsubscribe is idempotent", async () => {
            let called = false;
            const unsubscribe = uow.onEveryCommit(() => {
                called = true;
            });

            unsubscribe();
            unsubscribe();

            await uow.scope(async () => {
                await uow.withClient(async (client) => {
                    await insertRecord(client, 1);
                });
            });

            expect(called).toBe(false);
            await expectRecordExists(1);
        });
    });
});
