import { describe, expect, test } from "vitest";
import * as pg from "pg";
import _ from "lodash";

import { Propagation } from "@hexaijs/core";
import { IsolationLevel } from "./types.js";
import type { PostgresTransactionOptions } from "./types.js";
import {
    IncompatibleIsolationLevelError,
    TransactionAbortedError,
    TransactionClosedError,
    UnsupportedNestedTransactionCapabilityError,
} from "./postgres-unit-of-work.js";
import {
    captureRejection,
    createDeferred,
} from "./test-fixtures/async.fixtures.js";
import {
    areDistinctTransactions,
    areSameTransaction,
    expectTransactionAborted,
    getTransactionId,
    TABLE,
    useUnitOfWorkTestContext,
} from "./test-fixtures/unit-of-work-database.fixtures.js";

const DATABASE = "test_hexai__uow";

describe("PostgresUnitOfWork", () => {
    const {
        uow,
        insertRecord,
        expectRecordExists,
        expectRecordNotExists,
        expectRecordCount,
    } = useUnitOfWorkTestContext(DATABASE);

    // A scope whose callback works with the transaction's client.
    function scopeWithClient<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        options?: Partial<PostgresTransactionOptions>
    ): Promise<T> {
        return uow.scope(() => uow.withClient(fn), options);
    }

    async function runFailingTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await scopeWithClient(async (client) => {
                await fn(client);
                throw new Error("transaction failure");
            });
        } catch {
            // expected
        }
    }

    async function runFailingSavepoint(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await scopeWithClient(
                async (client) => {
                    await fn(client);
                    throw new Error("savepoint failure");
                },
                { propagation: Propagation.NESTED }
            );
        } catch {
            // expected
        }
    }

    async function runSavepoint(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        await scopeWithClient(fn, { propagation: Propagation.NESTED });
    }

    async function runNestedTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        await scopeWithClient(fn, { propagation: Propagation.EXISTING });
    }

    async function runFailingNestedTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await scopeWithClient(
                async (client) => {
                    await fn(client);
                    throw new Error("nested failure");
                },
                { propagation: Propagation.EXISTING }
            );
        } catch {
            // expected
        }
    }

    describe("transaction lifecycle", () => {
        test("throws when accessing client outside transaction boundary", async () => {
            expect(() => uow.getClient()).toThrowError(/.*not started.*/);
        });

        test("provides consistent client reference within transaction", async () => {
            const txids: string[] = [];

            await scopeWithClient(async (client) => {
                txids.push(await getTransactionId(client));
                txids.push(await getTransactionId(uow.getClient()));
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("commits all changes on successful completion", async () => {
            await scopeWithClient(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordExists(1);
        });

        test("rolls back all changes when error occurs", async () => {
            await runFailingTransaction(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordNotExists(1);
        });

        test("creates an isolated transaction for each scope", async () => {
            const txids: string[] = [];

            await Promise.all(
                _.times(5, async () => {
                    await scopeWithClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                })
            );

            expect(areDistinctTransactions(...txids)).toBe(true);
        });

        test("refuses queries through a client kept after the transaction ends", async () => {
            let capturedClient!: pg.ClientBase;

            await scopeWithClient(async () => {
                capturedClient = uow.getClient();
            });

            await expect(
                getTransactionId(capturedClient)
            ).rejects.toBeInstanceOf(TransactionClosedError);
        });
    });

    describe("joining existing transaction", () => {
        test.each([undefined, null, 0, ""])(
            "aborts the transaction when a participant scope rejects with %j",
            async (failure) => {
                const outcome = uow.scope(async () => {
                    await uow.withClient((client) => insertRecord(client, 1));
                    await uow
                        .scope(async () => {
                            throw failure;
                        })
                        .catch(() => undefined);
                });

                await expectTransactionAborted(outcome, failure);
                await expectRecordNotExists(1);
            }
        );

        test("shares transaction context with parent", async () => {
            const txids: string[] = [];

            await scopeWithClient(async (client) => {
                txids.push(await getTransactionId(client));

                await runNestedTransaction(async (nested) => {
                    txids.push(await getTransactionId(nested));
                });
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("starts new transaction when no parent exists", async () => {
            const txids: string[] = [];

            await scopeWithClient(
                async (client) => {
                    txids.push(await getTransactionId(client));
                    txids.push(await getTransactionId(client));
                },
                { propagation: Propagation.EXISTING }
            );

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("rolls back entire transaction when nested operation fails", async () => {
            const nestedFailure = new Error("nested failure");

            await expectTransactionAborted(
                scopeWithClient(async (client) => {
                    await insertRecord(client, 1);

                    try {
                        await scopeWithClient(
                            async () => {
                                throw nestedFailure;
                            },
                            { propagation: Propagation.EXISTING }
                        );
                    } catch {
                        // no commit-prevention marker: root finalization must
                        // not let this look like a successful transaction.
                    }
                }),
                nestedFailure
            );

            await expectRecordCount(0);
        });

        test("commits all changes when nested operations succeed", async () => {
            await scopeWithClient(async (client) => {
                await insertRecord(client, 1);

                await runNestedTransaction(async (nested) => {
                    await insertRecord(nested, 2);
                });
            });

            await expectRecordCount(2);
        });
    });

    describe("creating new transaction", () => {
        test("creates independent transaction for each NEW propagation", async () => {
            const txids: string[] = [];

            await scopeWithClient(async () => {
                await Promise.all(
                    _.times(5, async () => {
                        await scopeWithClient(
                            async (client) => {
                                txids.push(await getTransactionId(client));
                            },
                            { propagation: Propagation.NEW }
                        );
                    })
                );
            });

            expect(areDistinctTransactions(...txids)).toBe(true);
        });
    });

    describe("nested savepoints", () => {
        test("starts new transaction when no parent exists", async () => {
            const txids: string[] = [];

            await scopeWithClient(
                async (client) => {
                    txids.push(await getTransactionId(client));
                    txids.push(await getTransactionId(client));
                },
                { propagation: Propagation.NESTED }
            );

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("rolls back only savepoint changes while preserving parent transaction", async () => {
            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await runFailingSavepoint(async (savepoint) => {
                    await insertRecord(savepoint, 2);
                });

                await insertRecord(root, 3);

                await runSavepoint(async (savepoint) => {
                    await insertRecord(savepoint, 4);
                });
            });

            await expectRecordExists(1);
            await expectRecordNotExists(2);
            await expectRecordExists(3);
            await expectRecordExists(4);
        });

        test("aborts the whole transaction when a joining scope fails inside a savepoint, even if caught", async () => {
            const error = await captureRejection(
                scopeWithClient(async (root) => {
                    await insertRecord(root, 1);

                    await scopeWithClient(
                        async (savepoint) => {
                            await insertRecord(savepoint, 2);

                            await runFailingNestedTransaction(async () => {});
                        },
                        { propagation: Propagation.NESTED }
                    );
                })
            );

            expect(error).toBeInstanceOf(TransactionAbortedError);
            await expectRecordCount(0);
        });

        test("rejects a sibling NESTED scope that opens while another savepoint is open", async () => {
            const firstEntered = createDeferred();
            const finishFirst = createDeferred();
            let siblingError: unknown;

            await uow.scope(async () => {
                const first = uow.scope(
                    async () => {
                        firstEntered.resolve();
                        await finishFirst.promise;
                        await uow.scope(
                            () =>
                                uow.withClient((client) =>
                                    insertRecord(client, 1)
                                ),
                            { propagation: Propagation.NESTED }
                        );
                    },
                    { propagation: Propagation.NESTED }
                );
                await firstEntered.promise;
                siblingError = await captureRejection(
                    uow.scope(
                        () =>
                            uow.withClient((client) => insertRecord(client, 2)),
                        { propagation: Propagation.NESTED }
                    )
                );
                finishFirst.resolve();
                await first;
            });

            expect(siblingError).toBeInstanceOf(
                UnsupportedNestedTransactionCapabilityError
            );
            await expectRecordExists(1);
            await expectRecordNotExists(2);
        });
    });

    describe("transaction isolation", () => {
        test.each([
            IsolationLevel.READ_COMMITTED,
            IsolationLevel.REPEATABLE_READ,
            IsolationLevel.SERIALIZABLE,
        ])("applies %s isolation level", async (isolationLevel) => {
            await scopeWithClient(
                async (client) => {
                    const result = await client.query(
                        "SHOW TRANSACTION ISOLATION LEVEL"
                    );

                    expect(result.rows[0].transaction_isolation).toBe(
                        isolationLevel
                    );
                },
                { isolationLevel }
            );
        });

        const joiningCalls = [
            {
                description: "an EXISTING scope",
                join: (
                    fn: (client: pg.ClientBase) => Promise<void>,
                    isolationLevel?: IsolationLevel
                ) => uow.scope(() => uow.withClient(fn), { isolationLevel }),
            },
            {
                description: "a NESTED scope",
                join: (
                    fn: (client: pg.ClientBase) => Promise<void>,
                    isolationLevel?: IsolationLevel
                ) =>
                    uow.scope(() => uow.withClient(fn), {
                        isolationLevel,
                        propagation: Propagation.NESTED,
                    }),
            },
        ];

        async function showIsolationLevel(
            client: pg.ClientBase
        ): Promise<string> {
            const result = await client.query(
                "SHOW TRANSACTION ISOLATION LEVEL"
            );
            return result.rows[0].transaction_isolation;
        }

        describe.each(joiningCalls)("$description", ({ join }) => {
            test.each([
                {
                    name: "read committed in serializable",
                    ownerLevel: IsolationLevel.SERIALIZABLE,
                    requestedLevel: IsolationLevel.READ_COMMITTED,
                },
                {
                    name: "serializable in a default one",
                    ownerLevel: undefined,
                    requestedLevel: IsolationLevel.SERIALIZABLE,
                },
            ])(
                "rejects asking $name without running the callback",
                async ({ ownerLevel, requestedLevel }) => {
                    let callbackRan = false;
                    let joinError: unknown;

                    await uow.scope(
                        async () => {
                            joinError = await captureRejection(
                                join(async () => {
                                    callbackRan = true;
                                }, requestedLevel)
                            );
                        },
                        { isolationLevel: ownerLevel }
                    );

                    expect(joinError).toBeInstanceOf(
                        IncompatibleIsolationLevelError
                    );
                    expect((joinError as Error).message).toContain(
                        requestedLevel
                    );
                    expect((joinError as Error).message).toContain(
                        ownerLevel ?? IsolationLevel.READ_COMMITTED
                    );
                    expect(callbackRan).toBe(false);
                }
            );

            test.each([
                {
                    name: "serializable in serializable",
                    ownerLevel: IsolationLevel.SERIALIZABLE,
                    requestedLevel: IsolationLevel.SERIALIZABLE,
                },
                {
                    name: "read committed in a default one",
                    ownerLevel: undefined,
                    requestedLevel: IsolationLevel.READ_COMMITTED,
                },
                {
                    name: "no level in serializable",
                    ownerLevel: IsolationLevel.SERIALIZABLE,
                    requestedLevel: undefined,
                },
            ])(
                "joins asking $name",
                async ({ ownerLevel, requestedLevel }) => {
                    let appliedLevel: string | undefined;

                    await uow.scope(
                        () =>
                            join(async (client) => {
                                appliedLevel = await showIsolationLevel(client);
                            }, requestedLevel),
                        { isolationLevel: ownerLevel }
                    );

                    expect(appliedLevel).toBe(
                        ownerLevel ?? IsolationLevel.READ_COMMITTED
                    );
                }
            );
        });
    });

    describe("scope()", () => {
        async function runFailingScopeTransaction(
            fn: (client: pg.ClientBase) => Promise<void>
        ): Promise<void> {
            try {
                await uow.scope(async () => {
                    await uow.withClient(fn);
                    throw new Error("scope failure");
                });
            } catch {
                // expected
            }
        }

        describe("transaction lifecycle", () => {
            test("commits on success when withClient is used", async () => {
                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                await expectRecordExists(1);
            });

            test("rolls back on error when withClient is used", async () => {
                await runFailingScopeTransaction(async (client) => {
                    await insertRecord(client, 1);
                });

                await expectRecordNotExists(1);
            });

            test("no-op when withClient is never called", async () => {
                await uow.scope(async () => {
                    // intentionally empty — no withClient() call
                });

                await expectRecordCount(0);
            });

            test("consistent client reference across multiple withClient calls", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                });

                expect(areSameTransaction(...txids)).toBe(true);
            });
        });

        describe("lazy initialization", () => {
            test("withClient() triggers transaction start", async () => {
                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                    });
                });

                await expectRecordExists(1);
            });

            test("getClient() throws if withClient was never called", async () => {
                await uow.scope(async () => {
                    expect(() => uow.getClient()).toThrow(
                        "Transaction not initialized"
                    );
                });
            });
        });

        describe("nesting", () => {
            test("scope → scope(EXISTING): same transaction, both lazy until withClient", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.scope(
                        async () => {
                            await uow.withClient(async (client) => {
                                txids.push(await getTransactionId(client));
                            });
                        },
                        { propagation: Propagation.EXISTING }
                    );

                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                });

                expect(areSameTransaction(...txids)).toBe(true);
            });

            test("scope → scope(NEW): independent transactions", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });

                    await uow.scope(
                        async () => {
                            await uow.withClient(async (client) => {
                                txids.push(await getTransactionId(client));
                            });
                        },
                        { propagation: Propagation.NEW }
                    );
                });

                expect(areDistinctTransactions(...txids)).toBe(true);
            });

            test("scope → scope(NESTED): outer forced init + savepoint", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.withClient(async (client) => {
                        await insertRecord(client, 1);
                        txids.push(await getTransactionId(client));
                    });

                    try {
                        await uow.scope(
                            async () => {
                                await uow.withClient(async (client) => {
                                    await insertRecord(client, 2);
                                    txids.push(await getTransactionId(client));
                                });
                                throw new Error("savepoint failure");
                            },
                            { propagation: Propagation.NESTED }
                        );
                    } catch {
                        // expected
                    }
                });

                expect(areSameTransaction(...txids)).toBe(true);
                await expectRecordExists(1);
                await expectRecordNotExists(2);
            });

            test("started scope → scope(EXISTING): scope participates", async () => {
                const txids: string[] = [];

                await scopeWithClient(async (outerClient) => {
                    txids.push(await getTransactionId(outerClient));

                    await uow.scope(
                        async () => {
                            await uow.withClient(async (client) => {
                                txids.push(await getTransactionId(client));
                            });
                        },
                        { propagation: Propagation.EXISTING }
                    );
                });

                expect(areSameTransaction(...txids)).toBe(true);
            });
        });
    });

    describe("withClient method", () => {
        test("executes query without transaction", async () => {
            await uow.withClient(async (client) => {
                await insertRecord(client, 1);
            });

            await expectRecordExists(1);
        });

        test("reuses the transaction's client when inside scope()", async () => {
            const txids: string[] = [];

            await scopeWithClient(async (scopeClient) => {
                txids.push(await getTransactionId(scopeClient));

                await uow.withClient(async (queryClient) => {
                    txids.push(await getTransactionId(queryClient));
                });
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("uses separate connections when outside transaction", async () => {
            const txids: string[] = [];

            await uow.withClient(async (client) => {
                txids.push(await getTransactionId(client));
            });
            await uow.withClient(async (client) => {
                txids.push(await getTransactionId(client));
            });

            expect(areDistinctTransactions(...txids)).toBe(true);
        });

        test("cleans up client on error", async () => {
            await expect(
                uow.withClient(async () => {
                    throw new Error("query error");
                })
            ).rejects.toThrow("query error");
        });

        test("changes are visible immediately without transaction", async () => {
            await uow.withClient(async (client) => {
                await insertRecord(client, 1);
            });

            await uow.withClient(async (client) => {
                const result = await client.query(
                    `SELECT COUNT(*) FROM ${TABLE} WHERE id = 1;`
                );
                expect(parseInt(result.rows[0].count)).toBe(1);
            });
        });
    });
});
