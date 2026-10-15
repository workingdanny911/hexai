import { describe, expect, test } from "vitest";

import { Propagation } from "@hexaijs/core";
import {
    createTransactionResourceKey,
    UnsupportedNestedTransactionCapabilityError,
} from "./postgres-unit-of-work.js";
import {
    captureRejection,
    createDeferred,
} from "./test-fixtures/async.fixtures.js";
import {
    expectTransactionAborted,
    useUnitOfWorkTestContext,
} from "./test-fixtures/unit-of-work-database.fixtures.js";

const DATABASE = "test_hexai__uow_capabilities";

describe("PostgresUnitOfWork", () => {
    const { uow, insertRecord, expectRecordNotExists, expectRecordCount } =
        useUnitOfWorkTestContext(DATABASE);

    async function expectRollbackHookFailure(
        promise: Promise<unknown>,
        cause: unknown,
        hookFailure: unknown
    ): Promise<void> {
        let error: unknown;
        try {
            await promise;
        } catch (e) {
            error = e;
        }

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([hookFailure]);
        expect((error as AggregateError).cause).toBe(cause);
    }

    describe("transaction capabilities", () => {
        describe("commit prevention", () => {
            test("rolls back while preserving the callback result", async () => {
                const cause = new Error("event handler failed");
                const result = { error: cause };
                let beforeCommitCalled = false;
                let afterRollbackCalled = false;

                await expect(
                    uow.scope(async () => {
                        uow.beforeCommit(() => { beforeCommitCalled = true; });
                        uow.afterRollback(() => { afterRollbackCalled = true; });

                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });
                        expect(uow.isCommitPrevented()).toBe(false);
                        uow.preventCommit(cause);
                        expect(uow.isCommitPrevented()).toBe(true);
                        return result;
                    })
                ).resolves.toBe(result);

                expect(beforeCommitCalled).toBe(false);
                expect(afterRollbackCalled).toBe(true);
                await expectRecordNotExists(1);
            });

            test("keeps the first commit-prevention cause when the rollback hook fails", async () => {
                const firstCause = new Error("first failure");
                const secondCause = new Error("second failure");
                const hookFailure = new Error("rollback hook failed");

                await expectRollbackHookFailure(
                    uow.scope(async () => {
                        uow.afterRollback(() => { throw hookFailure; });
                        uow.preventCommit(firstCause);
                        uow.preventCommit(secondCause);
                    }),
                    firstCause,
                    hookFailure
                );
            });

            test("throws outside a transaction scope", () => {
                expect(() => uow.preventCommit()).toThrow(
                    /outside of a transaction scope/
                );
                expect(() => uow.isCommitPrevented()).toThrow(
                    /outside of a transaction scope/
                );
            });

            test("rejects commit-prevention access inside a nested savepoint", async () => {
                await uow.scope(async () => {
                    await expect(
                        uow.scope(
                            async () => {
                                uow.preventCommit();
                            },
                            { propagation: Propagation.NESTED }
                        )
                    ).rejects.toBeInstanceOf(
                        UnsupportedNestedTransactionCapabilityError
                    );
                });
            });

            test("allows commit prevention in the owner's context while a NESTED scope runs beside it", async () => {
                const nestedEntered = createDeferred();
                const finishNested = createDeferred();
                let nestedError: unknown;

                const result = await uow.scope(async () => {
                    await uow.withClient((client) => insertRecord(client, 1));
                    const nested = uow.scope(
                        async () => {
                            nestedEntered.resolve();
                            await finishNested.promise;
                            uow.preventCommit();
                        },
                        { propagation: Propagation.NESTED }
                    );
                    await nestedEntered.promise;

                    uow.preventCommit("prevented by the owner");
                    expect(uow.isCommitPrevented()).toBe(true);

                    finishNested.resolve();
                    nestedError = await captureRejection(nested);
                    return 42;
                });

                expect(result).toBe(42);
                expect(nestedError).toBeInstanceOf(
                    UnsupportedNestedTransactionCapabilityError
                );
                await expectRecordNotExists(1);
            });

            test("allows commit prevention in a NEW transaction opened inside a nested savepoint", async () => {
                await uow.scope(async () => {
                    await uow.scope(
                        async () => {
                            const result = await uow.scope(
                                async () => {
                                    await uow.withClient((client) =>
                                        insertRecord(client, 1)
                                    );
                                    uow.preventCommit();
                                    return uow.isCommitPrevented();
                                },
                                { propagation: Propagation.NEW }
                            );
                            expect(result).toBe(true);
                        },
                        { propagation: Propagation.NESTED }
                    );
                });

                await expectRecordNotExists(1);
            });

            test("rolls back while preserving an error result from a nested existing-scope failure", async () => {
                const nestedFailure = new Error("nested failure");
                const result = { error: nestedFailure };

                await expect(
                    uow.scope(async () => {
                        await uow.withClient(async (client) => {
                            await insertRecord(client, 1);
                        });

                        try {
                            await uow.scope(async () => {
                                await uow.withClient(async (client) => {
                                    await insertRecord(client, 2);
                                });
                                throw nestedFailure;
                            });
                        } catch (error) {
                            expect(error).toBe(nestedFailure);
                            uow.preventCommit(nestedFailure);
                            return result;
                        }
                    })
                ).resolves.toBe(result);

                await expectRecordCount(0);
            });

            test("throws when an aborted transaction returns without commit prevention", async () => {
                const nestedFailure = new Error("nested failure");

                await expectTransactionAborted(
                    uow.scope(async () => {
                        try {
                            await uow.scope(async () => {
                                await uow.withClient(async (client) => {
                                    await insertRecord(client, 1);
                                });
                                throw nestedFailure;
                            });
                        } catch {
                            return { ok: true };
                        }
                    }),
                    nestedFailure
                );

                await expectRecordCount(0);
            });

            test("uses the nested failure as the rollback cause when commit prevention also applies", async () => {
                const preventCause = new Error("event handler failed");
                const nestedFailure = new Error("nested failure");
                const hookFailure = new Error("rollback hook failed");

                await expectRollbackHookFailure(
                    uow.scope(async () => {
                        uow.afterRollback(() => { throw hookFailure; });
                        uow.preventCommit(preventCause);

                        try {
                            await uow.scope(async () => {
                                await uow.withClient(async (client) => {
                                    await insertRecord(client, 1);
                                });
                                throw nestedFailure;
                            });
                        } catch {
                            // The database transaction is already aborted, so
                            // that cause is more useful than the explicit
                            // commit-prevention cause if rollback finalization
                            // itself fails.
                        }
                    }),
                    nestedFailure,
                    hookFailure
                );

                await expectRecordCount(0);
            });

            test("keeps the first swallowed existing-scope failure as the rollback cause", async () => {
                const firstFailure = new Error("first nested failure");
                const secondFailure = new Error("second nested failure");
                const hookFailure = new Error("rollback hook failed");

                await expectRollbackHookFailure(
                    uow.scope(async () => {
                        uow.afterRollback(() => { throw hookFailure; });

                        try {
                            await uow.scope(async () => {
                                throw firstFailure;
                            });
                        } catch {
                            uow.preventCommit(firstFailure);
                        }

                        try {
                            await uow.scope(async () => {
                                throw secondFailure;
                            });
                        } catch {
                            // expected
                        }
                    }),
                    firstFailure,
                    hookFailure
                );
            });

            test("uses the commit-prevention cause when the rollback hook fails", async () => {
                const preventCause = new Error("event handler failed");
                const hookFailure = new Error("rollback hook failed");

                await expectRollbackHookFailure(
                    uow.scope(async () => {
                        uow.afterRollback(() => { throw hookFailure; });
                        uow.preventCommit(preventCause);
                    }),
                    preventCause,
                    hookFailure
                );
            });

            test("uses the swallowed failure cause when the rollback hook fails", async () => {
                const nestedFailure = new Error("nested failure");
                const hookFailure = new Error("rollback hook failed");

                await expectRollbackHookFailure(
                    uow.scope(async () => {
                        uow.afterRollback(() => { throw hookFailure; });

                        try {
                            await uow.scope(async () => {
                                await uow.withClient(async (client) => {
                                    await insertRecord(client, 1);
                                });
                                throw nestedFailure;
                            });
                        } catch {
                            uow.preventCommit(nestedFailure);
                        }
                    }),
                    nestedFailure,
                    hookFailure
                );

                await expectRecordCount(0);
            });
        });

        describe("transaction-local resources", () => {
            type BufferedValues = { values: string[] };
            const valuesKey =
                createTransactionResourceKey<BufferedValues>("values");

            test("reuses a resource within the current root transaction", async () => {
                let created = 0;

                await uow.scope(async () => {
                    const first = uow.getOrCreateTransactionResource(
                        valuesKey,
                        () => {
                            created++;
                            return { values: [] };
                        }
                    );
                    first.values.push("first");

                    const second = uow.getOrCreateTransactionResource(
                        valuesKey,
                        () => {
                            created++;
                            return { values: ["new"] };
                        }
                    );

                    expect(second).toBe(first);
                    expect(second.values).toEqual(["first"]);
                });

                expect(created).toBe(1);
            });

            test("keeps Propagation.NEW resources isolated from the parent transaction", async () => {
                await uow.scope(async () => {
                    uow.setTransactionResource(valuesKey, {
                        values: ["outer"],
                    });

                    await uow.scope(
                        async () => {
                            expect(
                                uow.getTransactionResource(valuesKey)
                            ).toBeUndefined();

                            uow.setTransactionResource(valuesKey, {
                                values: ["inner"],
                            });
                            expect(
                                uow.getTransactionResource(valuesKey)?.values
                            ).toEqual(["inner"]);
                        },
                        { propagation: Propagation.NEW }
                    );

                    expect(
                        uow.getTransactionResource(valuesKey)?.values
                    ).toEqual(["outer"]);
                });
            });

            test("rejects resource access inside a nested savepoint", async () => {
                await uow.scope(async () => {
                    await expect(
                        uow.scope(
                            async () => {
                                uow.getTransactionResource(valuesKey);
                            },
                            { propagation: Propagation.NESTED }
                        )
                    ).rejects.toBeInstanceOf(
                        UnsupportedNestedTransactionCapabilityError
                    );
                });
            });

            test("allows resource access in the owner's context while a NESTED scope runs beside it", async () => {
                const nestedEntered = createDeferred();
                const finishNested = createDeferred();
                let nestedError: unknown;

                await uow.scope(async () => {
                    const nested = uow.scope(
                        async () => {
                            nestedEntered.resolve();
                            await finishNested.promise;
                            uow.getTransactionResource(valuesKey);
                        },
                        { propagation: Propagation.NESTED }
                    );
                    await nestedEntered.promise;

                    uow.setTransactionResource(valuesKey, {
                        values: ["owner"],
                    });
                    expect(
                        uow.getTransactionResource(valuesKey)?.values
                    ).toEqual(["owner"]);

                    finishNested.resolve();
                    nestedError = await captureRejection(nested);
                });

                expect(nestedError).toBeInstanceOf(
                    UnsupportedNestedTransactionCapabilityError
                );
            });

            test("keeps parent resources usable after nested savepoint rejection", async () => {
                await uow.scope(async () => {
                    const parentResource = { values: ["outer"] };
                    uow.setTransactionResource(valuesKey, parentResource);

                    await expect(
                        uow.scope(
                            async () => {
                                uow.getTransactionResource(valuesKey);
                            },
                            { propagation: Propagation.NESTED }
                        )
                    ).rejects.toBeInstanceOf(
                        UnsupportedNestedTransactionCapabilityError
                    );

                    expect(uow.getTransactionResource(valuesKey)).toBe(
                        parentResource
                    );
                    parentResource.values.push("after-rejection");
                    expect(
                        uow.getTransactionResource(valuesKey)?.values
                    ).toEqual(["outer", "after-rejection"]);
                });
            });

            test("throws outside a transaction scope", () => {
                expect(() => uow.getTransactionResource(valuesKey)).toThrow(
                    /outside of a transaction scope/
                );
                expect(() =>
                    uow.getOrCreateTransactionResource(valuesKey, () => ({
                        values: [],
                    }))
                ).toThrow(/outside of a transaction scope/);
                expect(() =>
                    uow.setTransactionResource(valuesKey, { values: [] })
                ).toThrow(/outside of a transaction scope/);
            });
        });
    });
});
