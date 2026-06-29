import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import * as pg from "pg";
import _ from "lodash";

import { Propagation } from "@hexaijs/core";
import { IsolationLevel } from "./types.js";
import {
    createTransactionResourceKey,
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
    TransactionClosedError,
    UnsupportedNestedTransactionCapabilityError,
} from "./postgres-unit-of-work.js";
import {
    newClient,
    useClient,
    useDatabase,
    useTableManager,
} from "./test-fixtures/index.js";

const DATABASE = "test_hexai__uow";
const TABLE = "_test";

async function getTransactionId(client: pg.ClientBase): Promise<string> {
    const result = await client.query(`SELECT txid_current();`);
    return result.rows[0].txid_current;
}

function areSameTransaction(...txids: string[]): boolean {
    return new Set(txids).size === 1;
}

function areDistinctTransactions(...txids: string[]): boolean {
    return new Set(txids).size === txids.length;
}

function captureSyncError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
}

function expectNoActiveTransaction(error: unknown): void {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not started/);
}

function createDeferred(): {
    promise: Promise<void>;
    resolve: () => void;
} {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("PostgresUnitOfWork", () => {
    // requires admin privileges to create/drop databases
    useDatabase(DATABASE);
    const tableManager = useTableManager(DATABASE);
    const conn = useClient(DATABASE);
    const uow = new DefaultPostgresUnitOfWork(
        () => newClient(DATABASE),
        (c) => (c as pg.Client).end()
    );

    let verificationRepo: {
        exists: (id: number) => Promise<boolean>;
        count: () => Promise<number>;
    };

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [
            { name: "id", property: "INT" },
        ]);

        verificationRepo = {
            async exists(id: number): Promise<boolean> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE} WHERE id = $1;`,
                    [id]
                );
                return result.rows[0].count > 0;
            },
            async count(): Promise<number> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE};`
                );
                return parseInt(result.rows[0].count);
            },
        };
    });

    beforeEach(async () => {
        await tableManager.truncateTable(TABLE);
    });

    async function insertRecord(client: pg.ClientBase, id: number): Promise<void> {
        await client.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
    }

    async function expectRecordExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(true);
    }

    async function expectRecordNotExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(false);
    }

    async function expectRecordCount(count: number): Promise<void> {
        expect(await verificationRepo.count()).toBe(count);
    }

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

    async function expectTransactionAborted(
        promise: Promise<unknown>,
        cause: unknown
    ): Promise<void> {
        let error: unknown;
        try {
            await promise;
        } catch (e) {
            error = e;
        }

        expect(error).toBeInstanceOf(TransactionAbortedError);
        expect((error as Error).cause).toBe(cause);
    }

    async function runFailingTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(async (client) => {
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
            await uow.wrap(
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
        await uow.wrap(fn, { propagation: Propagation.NESTED });
    }

    async function runNestedTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        await uow.wrap(fn, { propagation: Propagation.EXISTING });
    }

    async function runFailingNestedTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await uow.wrap(
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

            await uow.wrap(async (client) => {
                txids.push(await getTransactionId(client));
                txids.push(await getTransactionId(uow.getClient()));
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("commits all changes on successful completion", async () => {
            await uow.wrap(async (client) => {
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

        test("creates isolated transaction for each wrap call", async () => {
            const txids: string[] = [];

            await Promise.all(
                _.times(5, async () => {
                    await uow.wrap(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                })
            );

            expect(areDistinctTransactions(...txids)).toBe(true);
        });

        test("releases database connection after transaction ends", async () => {
            let capturedClient!: pg.ClientBase;

            await uow.wrap(async () => {
                capturedClient = uow.getClient();
            });

            await expect(getTransactionId(capturedClient)).rejects.toThrowError(
                /.*closed.*/
            );
        });
    });

    describe("joining existing transaction", () => {
        test("shares transaction context with parent", async () => {
            const txids: string[] = [];

            await uow.wrap(async (client) => {
                txids.push(await getTransactionId(client));

                await runNestedTransaction(async (nested) => {
                    txids.push(await getTransactionId(nested));
                });
            });

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("starts new transaction when no parent exists", async () => {
            const txids: string[] = [];

            await uow.wrap(
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
                uow.wrap(async (client) => {
                    await insertRecord(client, 1);

                    try {
                        await uow.wrap(
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
            await uow.wrap(async (client) => {
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

            await uow.wrap(async () => {
                await Promise.all(
                    _.times(5, async () => {
                        await uow.wrap(
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

            await uow.wrap(
                async (client) => {
                    txids.push(await getTransactionId(client));
                    txids.push(await getTransactionId(client));
                },
                { propagation: Propagation.NESTED }
            );

            expect(areSameTransaction(...txids)).toBe(true);
        });

        test("rolls back only savepoint changes while preserving parent transaction", async () => {
            await uow.wrap(async (root) => {
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

        test("rolls back to savepoint when nested operation fails inside savepoint", async () => {
            await uow.wrap(async (root) => {
                await insertRecord(root, 1);

                await uow.wrap(
                    async (savepoint) => {
                        await insertRecord(savepoint, 2);

                        await runFailingNestedTransaction(async () => {});
                    },
                    { propagation: Propagation.NESTED }
                );
            });

            await expectRecordCount(1);
            await expectRecordExists(1);
        });
    });

    describe("transaction isolation", () => {
        test.each([
            IsolationLevel.READ_COMMITTED,
            IsolationLevel.REPEATABLE_READ,
            IsolationLevel.SERIALIZABLE,
        ])("applies %s isolation level", async (isolationLevel) => {
            await uow.wrap(
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
            test("scope → wrap(EXISTING): wrap triggers init, same transaction", async () => {
                const txids: string[] = [];

                await uow.scope(async () => {
                    await uow.wrap(
                        async (client) => {
                            txids.push(await getTransactionId(client));
                        },
                        { propagation: Propagation.EXISTING }
                    );

                    await uow.withClient(async (client) => {
                        txids.push(await getTransactionId(client));
                    });
                });

                expect(areSameTransaction(...txids)).toBe(true);
            });

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

            test("wrap → scope(EXISTING): already initialized, scope participates", async () => {
                const txids: string[] = [];

                await uow.wrap(async (wrapClient) => {
                    txids.push(await getTransactionId(wrapClient));

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

        test("reuses client when inside wrap()", async () => {
            const txids: string[] = [];

            await uow.wrap(async (wrapClient) => {
                txids.push(await getTransactionId(wrapClient));

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
