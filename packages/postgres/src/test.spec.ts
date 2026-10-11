import {
    beforeAll,
    beforeEach,
    afterEach,
    describe,
    expect,
    test,
    vi,
} from "vitest";
import * as pg from "pg";

import { Propagation } from "@hexaijs/core";
import { PostgresUnitOfWorkForTesting } from "./test.js";
import type { PostgresTransactionOptions } from "./types.js";
import {
    newClient,
    useClient,
    useDatabase,
    useTableManager,
} from "./test-fixtures/index.js";

const DATABASE = "test_hexai__uow_testing";
const TABLE = "_test";

describe("PostgresUnitOfWorkForTesting", () => {
    useDatabase(DATABASE);
    const tableManager = useTableManager(DATABASE);
    const conn = useClient(DATABASE);

    let client: pg.Client;
    let uow: PostgresUnitOfWorkForTesting;

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [{ name: "id", property: "INT" }]);
    });

    beforeEach(async () => {
        client = newClient(DATABASE);
        await client.connect();
        await client.query("BEGIN");
        uow = new PostgresUnitOfWorkForTesting(client);
    });

    afterEach(async () => {
        await client.query("ROLLBACK");
        await client.end();
    });

    // A scope whose callback works with the transaction's client.
    function scopeWithClient<T>(
        fn: (client: pg.ClientBase) => Promise<T>,
        options?: Partial<PostgresTransactionOptions>
    ): Promise<T> {
        return uow.scope(() => uow.withClient(fn), options);
    }

    async function insertRecord(c: pg.ClientBase, id: number): Promise<void> {
        await c.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
    }

    async function getRecordIds(): Promise<number[]> {
        const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
        return result.rows.map((r) => r.id);
    }

    async function expectRecordIds(ids: number[]): Promise<void> {
        expect(await getRecordIds()).toEqual(ids);
    }

    async function expectRecordCount(count: number): Promise<void> {
        expect(await getRecordIds()).toHaveLength(count);
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

    async function runFailingTransaction(
        fn: (client: pg.ClientBase) => Promise<void>
    ): Promise<void> {
        try {
            await scopeWithClient(async (c) => {
                await fn(c);
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
                async (c) => {
                    await fn(c);
                    throw new Error("savepoint failure");
                },
                { propagation: Propagation.NESTED }
            );
        } catch {
            // expected
        }
    }

    describe("transaction lifecycle", () => {
        test("commits changes on successful completion", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
        });

        test("rolls back changes when error occurs", async () => {
            await runFailingTransaction(async (c) => {
                await insertRecord(c, 1);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(0);
        });

        test("allows client reuse after error", async () => {
            await runFailingTransaction(async (c) => {
                await insertRecord(c, 1);
            });

            await scopeWithClient(async (c) => {
                await insertRecord(c, 2);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(2);
        });

        test("changes within uow are not visible to external connection during test", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);
            });

            const externalResult = await conn.query(`SELECT * FROM ${TABLE}`);
            expect(externalResult.rows).toHaveLength(0);
        });
    });

    describe("joining existing transaction", () => {
        test("rolls back entire transaction when nested EXISTING fails even if caught", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);

                try {
                    await scopeWithClient(async () => {
                        throw new Error("nested failure");
                    });
                } catch {
                    // caught but should still abort
                }

                await insertRecord(c, 2);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(0);
        });

        test("commits all changes when nested operations succeed", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);

                await scopeWithClient(async (nested) => {
                    await insertRecord(nested, 2);
                });
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(2);
        });
    });

    describe("nested savepoints", () => {
        test("rolls back only savepoint changes while preserving parent", async () => {
            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await runFailingSavepoint(async (sp) => {
                    await insertRecord(sp, 2);
                });

                await insertRecord(root, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 3]);
        });

        test("commits savepoint changes on success", async () => {
            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await scopeWithClient(
                    async (sp) => {
                        await insertRecord(sp, 2);
                    },
                    { propagation: Propagation.NESTED }
                );

                await insertRecord(root, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3]);
        });

        test("rolls back to savepoint when nested operation fails inside savepoint", async () => {
            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await scopeWithClient(
                    async (savepoint) => {
                        await insertRecord(savepoint, 2);

                        try {
                            await scopeWithClient(async () => {
                                throw new Error("nested failure");
                            });
                        } catch {
                            // caught - savepoint should be aborted
                        }
                    },
                    { propagation: Propagation.NESTED }
                );
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].id).toBe(1);
        });
    });

    describe.each([
        { label: "undefined", failure: undefined },
        { label: "null", failure: null },
        { label: "0", failure: 0 },
        { label: "an empty string", failure: "" },
        { label: "false", failure: false },
    ])("callback rejecting with $label", ({ failure }) => {
        test("rolls back the transaction", async () => {
            const settled = scopeWithClient(async (c) => {
                await insertRecord(c, 1);
                throw failure;
            });

            await expect(settled).rejects.toBe(failure);
            await expectRecordIds([]);
        });

        test("rolls back the entire transaction from a joining scope even if caught", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);

                await uow
                    .scope(async () => {
                        throw failure;
                    })
                    .catch(() => {});

                await insertRecord(c, 2);
            });

            await expectRecordIds([]);
        });

        test("rolls back only the savepoint it fails in", async () => {
            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await scopeWithClient(
                    async (sp) => {
                        await insertRecord(sp, 2);
                        throw failure;
                    },
                    { propagation: Propagation.NESTED }
                ).catch(() => {});

                await insertRecord(root, 3);
            });

            await expectRecordIds([1, 3]);
        });
    });

    describe("Propagation.NEW", () => {
        test("logs warning and creates new savepoint", async () => {
            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

            await scopeWithClient(async (root) => {
                await insertRecord(root, 1);

                await scopeWithClient(
                    async (newTx) => {
                        await insertRecord(newTx, 2);
                    },
                    { propagation: Propagation.NEW }
                );
            });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining("Propagation.NEW is not fully supported")
            );

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2]);

            warnSpy.mockRestore();
        });
    });

    describe("sequential operations", () => {
        test("handles multiple sequential scopes", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 1);
            });

            await scopeWithClient(async (c) => {
                await insertRecord(c, 2);
            });

            await scopeWithClient(async (c) => {
                await insertRecord(c, 3);
            });

            const result = await client.query(`SELECT id FROM ${TABLE} ORDER BY id`);
            expect(result.rows.map((r) => r.id)).toEqual([1, 2, 3]);
        });
    });

    describe("test isolation", () => {
        test("external transaction rollback cleans up all changes", async () => {
            await scopeWithClient(async (c) => {
                await insertRecord(c, 100);
            });

            const beforeRollback = await client.query(`SELECT * FROM ${TABLE}`);
            expect(beforeRollback.rows).toHaveLength(1);

            await client.query("ROLLBACK");
            await client.query("BEGIN");

            const afterRollback = await client.query(`SELECT * FROM ${TABLE}`);
            expect(afterRollback.rows).toHaveLength(0);
        });
    });

    describe("withClient method", () => {
        test("executes query using test client", async () => {
            await uow.withClient(async (c) => {
                await insertRecord(c, 1);
            });

            const result = await client.query(`SELECT * FROM ${TABLE}`);
            expect(result.rows).toHaveLength(1);
        });

        test("uses same client inside scope()", async () => {
            await scopeWithClient(async (scopeClient) => {
                await insertRecord(scopeClient, 1);

                await uow.withClient(async (queryClient) => {
                    const result = await queryClient.query(
                        `SELECT * FROM ${TABLE} WHERE id = 1`
                    );
                    expect(result.rows).toHaveLength(1);
                });
            });
        });

        test("uses same client outside scope()", async () => {
            await uow.withClient(async (c) => {
                await insertRecord(c, 1);
            });

            await uow.withClient(async (c) => {
                const result = await c.query(`SELECT * FROM ${TABLE}`);
                expect(result.rows).toHaveLength(1);
            });
        });
    });

    describe("transaction lifecycle hooks", () => {
        describe("beforeCommit", () => {
            test("executes before commit", async () => {
                let called = false;

                await scopeWithClient(async (c) => {
                    uow.beforeCommit(() => { called = true; });
                    await insertRecord(c, 1);
                });

                expect(called).toBe(true);
                await expectRecordCount(1);
            });

            test("runs drain-phase hooks after main hooks", async () => {
                const order: string[] = [];

                await scopeWithClient(async (c) => {
                    uow.beforeCommit(() => { order.push("drain"); }, {
                        phase: "drain",
                    });
                    uow.beforeCommit(() => { order.push("main"); });
                    await insertRecord(c, 1);
                });

                expect(order).toEqual(["main", "drain"]);
                await expectRecordCount(1);
            });

            test("triggers rollback when hook throws", async () => {
                try {
                    await scopeWithClient(async (c) => {
                        uow.beforeCommit(() => {
                            throw new Error("hook failure");
                        });
                        await insertRecord(c, 1);
                    });
                } catch (e) {
                    expect((e as Error).message).toBe("hook failure");
                }

                await expectRecordCount(0);
            });

            describe("when a hook's work aborts the transaction or prevents the commit", () => {
                const ROLLED_BACK_STATEMENTS = [
                    "SAVEPOINT <savepoint>",
                    `INSERT INTO ${TABLE} VALUES ($1);`,
                    "ROLLBACK TO SAVEPOINT <savepoint>",
                ];

                async function runRootWithHook(hook: () => unknown) {
                    const query = vi.spyOn(client, "query");
                    const calls = {
                        afterCommit: 0,
                        afterRollback: 0,
                        onEveryCommit: 0,
                    };
                    uow.onEveryCommit(() => {
                        calls.onEveryCommit++;
                    });

                    const settlement = await scopeWithClient(async (c) => {
                        uow.afterCommit(() => {
                            calls.afterCommit++;
                        });
                        uow.afterRollback(() => {
                            calls.afterRollback++;
                        });
                        uow.beforeCommit(async () => {
                            await hook();
                        });
                        await insertRecord(c, 1);
                        return "root result";
                    }).then(
                        (value) => ({ value }),
                        (error: unknown) => ({ error })
                    );
                    const statements = query.mock.calls.map(([statement]) =>
                        String(statement).replace(/test_sp_\w+/g, "<savepoint>")
                    );
                    query.mockRestore();

                    return { settlement, statements, calls };
                }

                describe.each([
                    { label: "undefined", failure: undefined },
                    { label: "an Error", failure: new Error("hook scope failure") },
                ])("with a scope that rejects with $label", ({ failure }) => {
                    test("rolls back once and reports no commit when the hook catches the failure", async () => {
                        const { settlement, statements, calls } =
                            await runRootWithHook(() =>
                                uow
                                    .scope(async () => {
                                        throw failure;
                                    })
                                    .catch(() => {})
                            );

                        expect(settlement).toStrictEqual({
                            value: "root result",
                        });
                        expect(statements).toEqual(ROLLED_BACK_STATEMENTS);
                        expect(calls).toEqual({
                            afterCommit: 0,
                            afterRollback: 1,
                            onEveryCommit: 0,
                        });
                        await expectRecordIds([]);
                    });

                    test("rolls back once and rejects with the failure when it leaves the hook", async () => {
                        const { settlement, statements, calls } =
                            await runRootWithHook(() =>
                                uow.scope(async () => {
                                    throw failure;
                                })
                            );

                        expect(settlement).toStrictEqual({ error: failure });
                        expect(statements).toEqual(ROLLED_BACK_STATEMENTS);
                        expect(calls).toEqual({
                            afterCommit: 0,
                            afterRollback: 1,
                            onEveryCommit: 0,
                        });
                        await expectRecordIds([]);
                    });
                });

                test("commits once when the hook runs a scope that succeeds", async () => {
                    const { settlement, statements, calls } =
                        await runRootWithHook(() =>
                            uow.scope(() =>
                                uow.withClient((c) => insertRecord(c, 2))
                            )
                        );

                    expect(settlement).toStrictEqual({ value: "root result" });
                    expect(statements).toEqual([
                        "SAVEPOINT <savepoint>",
                        `INSERT INTO ${TABLE} VALUES ($1);`,
                        `INSERT INTO ${TABLE} VALUES ($1);`,
                        "RELEASE SAVEPOINT <savepoint>",
                    ]);
                    expect(calls).toEqual({
                        afterCommit: 1,
                        afterRollback: 0,
                        onEveryCommit: 1,
                    });
                    await expectRecordIds([1, 2]);
                });

                test("rolls back when the hook prevents the commit", async () => {
                    const { settlement, statements, calls } =
                        await runRootWithHook(() => uow.preventCommit());

                    expect(settlement).toStrictEqual({ value: "root result" });
                    expect(statements).toEqual(ROLLED_BACK_STATEMENTS);
                    expect(calls).toEqual({
                        afterCommit: 0,
                        afterRollback: 1,
                        onEveryCommit: 0,
                    });
                    await expectRecordIds([]);
                });
            });
        });

        describe("afterCommit", () => {
            test("executes after successful commit", async () => {
                let called = false;

                await scopeWithClient(async (c) => {
                    uow.afterCommit(() => { called = true; });
                    await insertRecord(c, 1);
                });

                expect(called).toBe(true);
            });

            test("does not execute when scope fails", async () => {
                let called = false;

                try {
                    await scopeWithClient(async (c) => {
                        uow.afterCommit(() => { called = true; });
                        await insertRecord(c, 1);
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(false);
            });
        });

        describe("afterRollback", () => {
            test("executes after rollback on failure", async () => {
                let called = false;

                try {
                    await scopeWithClient(async (c) => {
                        uow.afterRollback(() => { called = true; });
                        await insertRecord(c, 1);
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(true);
            });

            test("does not execute on successful commit", async () => {
                let called = false;

                await scopeWithClient(async (c) => {
                    uow.afterRollback(() => { called = true; });
                    await insertRecord(c, 1);
                });

                expect(called).toBe(false);
            });
        });

        describe("transaction context", () => {
            test("keeps beforeCommit hooks inside the active test transaction", async () => {
                let directClient!: pg.ClientBase;

                await scopeWithClient(async (c) => {
                    uow.beforeCommit(() => {
                        directClient = uow.getClient();
                    });
                    await insertRecord(c, 1);
                });

                expect(directClient).toBe(client);
                await expectRecordIds([1]);
            });

            test("runs afterCommit outside the completed test transaction context", async () => {
                let directClientError: unknown;

                await scopeWithClient(async (c) => {
                    uow.afterCommit(async () => {
                        directClientError = captureSyncError(() =>
                            uow.getClient()
                        );

                        await uow.withClient(async (hookClient) => {
                            await insertRecord(hookClient, 2);
                        });
                    });

                    await insertRecord(c, 1);
                });

                expectNoActiveTransaction(directClientError);
                await expectRecordIds([1, 2]);
            });

            test("runs afterRollback outside the completed test transaction context", async () => {
                const scopeFailure = new Error("scope failure");
                let directClientError: unknown;

                await expect(
                    scopeWithClient(async (c) => {
                        uow.afterRollback(async () => {
                            directClientError = captureSyncError(() =>
                                uow.getClient()
                            );

                            await uow.withClient(async (hookClient) => {
                                await insertRecord(hookClient, 2);
                            });
                        });

                        await insertRecord(c, 1);
                        throw scopeFailure;
                    })
                ).rejects.toBe(scopeFailure);

                expectNoActiveTransaction(directClientError);
                await expectRecordIds([2]);
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

        describe("best-effort execution", () => {
            test("afterCommit runs all hooks even when one throws", async () => {
                let secondHookCalled = false;

                await expect(
                    scopeWithClient(async (c) => {
                        uow.afterCommit(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterCommit(() => { secondHookCalled = true; });
                        await insertRecord(c, 1);
                    })
                ).rejects.toBeInstanceOf(AggregateError);

                expect(secondHookCalled).toBe(true);
                await expectRecordCount(1);
            });

            test("afterRollback runs all hooks even when one throws", async () => {
                let secondHookCalled = false;

                await expect(
                    scopeWithClient(async (c) => {
                        uow.afterRollback(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterRollback(() => { secondHookCalled = true; });
                        await insertRecord(c, 1);
                        throw new Error("scope failure");
                    })
                ).rejects.toBeInstanceOf(AggregateError);

                expect(secondHookCalled).toBe(true);
                await expectRecordCount(0);
            });
        });

        describe("error cause chaining", () => {
            test("scope failure is preserved as cause when afterRollback hook fails", async () => {
                const scopeError = new Error("scope failure");

                try {
                    await scopeWithClient(async (c) => {
                        uow.afterRollback(() => {
                            throw new Error("hook failure");
                        });
                        await insertRecord(c, 1);
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
                    await scopeWithClient(async (c) => {
                        uow.beforeCommit(() => { throw beforeCommitError; });
                        uow.afterRollback(() => {
                            throw new Error("hook failure");
                        });
                        await insertRecord(c, 1);
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBe(beforeCommitError);
                }
            });

            test("afterCommit failure has no cause on success path", async () => {
                try {
                    await scopeWithClient(async (c) => {
                        uow.afterCommit(() => {
                            throw new Error("hook failure");
                        });
                        await insertRecord(c, 1);
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBeUndefined();
                }
            });
        });
    });

    describe("onEveryCommit observer", () => {
        test("runs after successful test transaction commit and after afterCommit hooks", async () => {
            const order: string[] = [];
            let directClientError: unknown;
            const unsubscribe = uow.onEveryCommit(async () => {
                order.push("observer");
                directClientError = captureSyncError(() => uow.getClient());

                await uow.withClient(async (c) => {
                    await insertRecord(c, 2);
                });
            });

            try {
                await scopeWithClient(async (c) => {
                    uow.afterCommit(() => { order.push("afterCommit"); });
                    await insertRecord(c, 1);
                });

                expect(order).toEqual(["afterCommit", "observer"]);
                expectNoActiveTransaction(directClientError);
                await expectRecordIds([1, 2]);
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
                await scopeWithClient(async (root) => {
                    await insertRecord(root, 1);

                    await scopeWithClient(
                        async (savepoint) => {
                            await insertRecord(savepoint, 2);
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
                await expectRecordIds([1, 2]);
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
                const result = await scopeWithClient(async (c) => {
                    await insertRecord(c, 1);
                    return "ok";
                });

                expect(result).toBe("ok");
                expect(secondObserverCalled).toBe(true);
                expect(errorSpy).toHaveBeenCalledWith(
                    "PostgresUnitOfWorkForTesting onEveryCommit observer failed",
                    observerFailure
                );
                await expectRecordIds([1]);
            } finally {
                unsubscribeFailing();
                unsubscribeSecond();
                errorSpy.mockRestore();
            }
        });
    });
});
