import { beforeEach, describe, expect, test } from "vitest";
import { Database, open } from "sqlite";
import sqlite3 from "sqlite3";

import { SqliteUnitOfWork } from "./sqlite-unit-of-work";

describe("unit of work", () => {
    let db: Database;
    let uow: SqliteUnitOfWork;

    beforeEach(async () => {
        db = await open({
            filename: ":memory:",
            driver: sqlite3.Database,
        });

        await db.run(`
            CREATE TABLE test (
                value TEXT
            )
        `);

        uow = new SqliteUnitOfWork(db);

        return async () => {
            await db.close();
        };
    });

    test("getClient() throws error outside of wrap", () => {
        expect(() => uow.getClient()).toThrowError();
    });

    test("when successful", async () => {
        uow = new SqliteUnitOfWork(db);

        const result = await uow.wrap(async () => {
            await db.run("INSERT INTO test VALUES ('foo')");
            return "result";
        });

        expect(result).toBe("result");
        const rows = await db.all("SELECT * FROM test");
        expect(rows).toEqual([{ value: "foo" }]);
    });

    test("rolling back", async () => {
        try {
            await uow.wrap(async () => {
                await db.run("INSERT INTO test VALUES ('foo')");
                throw new Error("rollback");
            });
        } catch (e) {
            expect((e as Error).message).toBe("rollback");
        }

        const rows = await db.all("SELECT * FROM test");
        expect(rows).toEqual([]);
    });

    test("when nested", async () => {
        await uow.wrap(async () => {
            await db.run("INSERT INTO test VALUES ('foo')");
            await uow.wrap(async () => {
                await db.run("INSERT INTO test VALUES ('bar')");
            });
        });

        const rows = await db.all("SELECT * FROM test");
        expect(rows).toEqual([{ value: "foo" }, { value: "bar" }]);
    });

    test("when error in nested", async () => {
        try {
            await uow.wrap(async () => {
                await db.run("INSERT INTO test VALUES ('foo')");

                await uow.wrap(async () => {
                    await db.run("INSERT INTO test VALUES ('bar')");
                    throw new Error("rollback");
                });
            });
        } catch (e) {
            expect((e as Error).message).toBe("rollback");
        }

        const rows = await db.all("SELECT * FROM test");
        expect(rows).toEqual([]);
    });

    describe("transaction lifecycle hooks", () => {
        describe("beforeCommit", () => {
            test("executes before COMMIT", async () => {
                await uow.wrap(async () => {
                    await db.run("INSERT INTO test VALUES ('scope')");
                    uow.beforeCommit(async () => {
                        await db.run("INSERT INTO test VALUES ('hook')");
                    });
                });

                const rows = await db.all("SELECT * FROM test");
                expect(rows).toEqual([
                    { value: "scope" },
                    { value: "hook" },
                ]);
            });

            test("executes in registration order", async () => {
                const order: number[] = [];

                await uow.wrap(async () => {
                    uow.beforeCommit(async () => { order.push(1); });
                    uow.beforeCommit(async () => { order.push(2); });
                    uow.beforeCommit(async () => { order.push(3); });
                });

                expect(order).toEqual([1, 2, 3]);
            });

            test("triggers rollback when hook throws", async () => {
                try {
                    await uow.wrap(async () => {
                        await db.run("INSERT INTO test VALUES ('foo')");
                        uow.beforeCommit(async () => {
                            throw new Error("hook failure");
                        });
                    });
                } catch (e) {
                    expect((e as Error).message).toBe("hook failure");
                }

                const rows = await db.all("SELECT * FROM test");
                expect(rows).toEqual([]);
            });
        });

        describe("afterCommit", () => {
            test("executes after successful commit", async () => {
                let called = false;

                await uow.wrap(async () => {
                    uow.afterCommit(async () => { called = true; });
                });

                expect(called).toBe(true);
            });

            test("does not execute on scope failure", async () => {
                let called = false;

                try {
                    await uow.wrap(async () => {
                        uow.afterCommit(async () => { called = true; });
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(false);
            });

            test("does not execute on beforeCommit failure", async () => {
                let called = false;

                try {
                    await uow.wrap(async () => {
                        uow.beforeCommit(async () => {
                            throw new Error("beforeCommit failure");
                        });
                        uow.afterCommit(async () => { called = true; });
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(false);
            });
        });

        describe("afterRollback", () => {
            test("executes on scope failure", async () => {
                let called = false;

                try {
                    await uow.wrap(async () => {
                        uow.afterRollback(async () => { called = true; });
                        throw new Error("scope failure");
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(true);
            });

            test("executes on beforeCommit failure", async () => {
                let called = false;

                try {
                    await uow.wrap(async () => {
                        uow.beforeCommit(async () => {
                            throw new Error("beforeCommit failure");
                        });
                        uow.afterRollback(async () => { called = true; });
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(true);
            });

            test("does not execute on success", async () => {
                let called = false;

                await uow.wrap(async () => {
                    uow.afterRollback(async () => { called = true; });
                });

                expect(called).toBe(false);
            });
        });

        describe("hook registration outside scope", () => {
            test("throws for beforeCommit", () => {
                expect(() => uow.beforeCommit(() => {})).toThrowError(
                    /outside of a transaction scope/
                );
            });

            test("throws for afterCommit", () => {
                expect(() => uow.afterCommit(() => {})).toThrowError(
                    /outside of a transaction scope/
                );
            });

            test("throws for afterRollback", () => {
                expect(() => uow.afterRollback(() => {})).toThrowError(
                    /outside of a transaction scope/
                );
            });
        });

        describe("nesting", () => {
            test("hooks in nested scope execute at root commit", async () => {
                let called = false;

                await uow.wrap(async () => {
                    await db.run("INSERT INTO test VALUES ('outer')");

                    await uow.wrap(async () => {
                        await db.run("INSERT INTO test VALUES ('inner')");
                        uow.afterCommit(async () => { called = true; });
                    });
                });

                expect(called).toBe(true);
                const rows = await db.all("SELECT * FROM test");
                expect(rows).toEqual([
                    { value: "outer" },
                    { value: "inner" },
                ]);
            });
        });

        describe("best-effort execution", () => {
            test("afterCommit runs all hooks even if one throws", async () => {
                let secondCalled = false;

                try {
                    await uow.wrap(async () => {
                        uow.afterCommit(async () => {
                            throw new Error("first hook fails");
                        });
                        uow.afterCommit(async () => { secondCalled = true; });
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                }

                expect(secondCalled).toBe(true);
            });

            test("afterRollback runs all hooks even if one throws", async () => {
                let secondCalled = false;

                try {
                    await uow.wrap(async () => {
                        uow.afterRollback(async () => {
                            throw new Error("first hook fails");
                        });
                        uow.afterRollback(async () => { secondCalled = true; });
                        throw new Error("scope failure");
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                }

                expect(secondCalled).toBe(true);
            });
        });

        describe("error cause chaining", () => {
            test("scope failure is preserved as cause when afterRollback hook fails", async () => {
                const scopeError = new Error("scope failure");

                try {
                    await uow.wrap(async () => {
                        uow.afterRollback(async () => {
                            throw new Error("hook failure");
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
                    await uow.wrap(async () => {
                        uow.beforeCommit(async () => { throw beforeCommitError; });
                        uow.afterRollback(async () => {
                            throw new Error("hook failure");
                        });
                    });
                } catch (e) {
                    expect(e).toBeInstanceOf(AggregateError);
                    expect((e as AggregateError).cause).toBe(beforeCommitError);
                }
            });

            test("afterCommit failure has no cause on success path", async () => {
                try {
                    await uow.wrap(async () => {
                        uow.afterCommit(async () => {
                            throw new Error("hook failure");
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
