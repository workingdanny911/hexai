import { beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { SqliteUnitOfWork } from "./sqlite-unit-of-work";

describe("unit of work", () => {
    let db: InstanceType<typeof Database>;
    let uow: SqliteUnitOfWork;

    beforeEach(() => {
        db = new Database(":memory:");

        db.exec(`
            CREATE TABLE test (
                value TEXT
            )
        `);

        uow = new SqliteUnitOfWork(db);

        return () => {
            db.close();
        };
    });

    test("getClient() throws error outside of wrap", () => {
        expect(() => uow.getClient()).toThrowError();
    });

    test("when successful", async () => {
        uow = new SqliteUnitOfWork(db);

        const result = await uow.wrap(async () => {
            db.prepare("INSERT INTO test VALUES ('foo')").run();
            return "result";
        });

        expect(result).toBe("result");
        const rows = db.prepare("SELECT * FROM test").all();
        expect(rows).toEqual([{ value: "foo" }]);
    });

    test("rolling back", async () => {
        try {
            await uow.wrap(async () => {
                db.prepare("INSERT INTO test VALUES ('foo')").run();
                throw new Error("rollback");
            });
        } catch (e) {
            expect((e as Error).message).toBe("rollback");
        }

        const rows = db.prepare("SELECT * FROM test").all();
        expect(rows).toEqual([]);
    });

    test("when nested", async () => {
        await uow.wrap(async () => {
            db.prepare("INSERT INTO test VALUES ('foo')").run();
            await uow.wrap(async () => {
                db.prepare("INSERT INTO test VALUES ('bar')").run();
            });
        });

        const rows = db.prepare("SELECT * FROM test").all();
        expect(rows).toEqual([{ value: "foo" }, { value: "bar" }]);
    });

    test("when error in nested", async () => {
        try {
            await uow.wrap(async () => {
                db.prepare("INSERT INTO test VALUES ('foo')").run();

                await uow.wrap(async () => {
                    db.prepare("INSERT INTO test VALUES ('bar')").run();
                    throw new Error("rollback");
                });
            });
        } catch (e) {
            expect((e as Error).message).toBe("rollback");
        }

        const rows = db.prepare("SELECT * FROM test").all();
        expect(rows).toEqual([]);
    });

    describe("transaction lifecycle hooks", () => {
        describe("beforeCommit", () => {
            test("executes before COMMIT", async () => {
                await uow.wrap(async () => {
                    db.prepare("INSERT INTO test VALUES ('scope')").run();
                    uow.beforeCommit(() => {
                        db.prepare("INSERT INTO test VALUES ('hook')").run();
                    });
                });

                const rows = db.prepare("SELECT * FROM test").all();
                expect(rows).toEqual([
                    { value: "scope" },
                    { value: "hook" },
                ]);
            });

            test("executes in registration order", async () => {
                const order: number[] = [];

                await uow.wrap(async () => {
                    uow.beforeCommit(() => { order.push(1); });
                    uow.beforeCommit(() => { order.push(2); });
                    uow.beforeCommit(() => { order.push(3); });
                });

                expect(order).toEqual([1, 2, 3]);
            });

            test("triggers rollback when hook throws", async () => {
                try {
                    await uow.wrap(async () => {
                        db.prepare("INSERT INTO test VALUES ('foo')").run();
                        uow.beforeCommit(() => {
                            throw new Error("hook failure");
                        });
                    });
                } catch (e) {
                    expect((e as Error).message).toBe("hook failure");
                }

                const rows = db.prepare("SELECT * FROM test").all();
                expect(rows).toEqual([]);
            });
        });

        describe("afterCommit", () => {
            test("executes after successful commit", async () => {
                let called = false;

                await uow.wrap(async () => {
                    uow.afterCommit(() => { called = true; });
                });

                expect(called).toBe(true);
            });

            test("does not execute on scope failure", async () => {
                let called = false;

                try {
                    await uow.wrap(async () => {
                        uow.afterCommit(() => { called = true; });
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
                        uow.beforeCommit(() => {
                            throw new Error("beforeCommit failure");
                        });
                        uow.afterCommit(() => { called = true; });
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
                        uow.afterRollback(() => { called = true; });
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
                        uow.beforeCommit(() => {
                            throw new Error("beforeCommit failure");
                        });
                        uow.afterRollback(() => { called = true; });
                    });
                } catch {
                    // expected
                }

                expect(called).toBe(true);
            });

            test("does not execute on success", async () => {
                let called = false;

                await uow.wrap(async () => {
                    uow.afterRollback(() => { called = true; });
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
                    db.prepare("INSERT INTO test VALUES ('outer')").run();

                    await uow.wrap(async () => {
                        db.prepare("INSERT INTO test VALUES ('inner')").run();
                        uow.afterCommit(() => { called = true; });
                    });
                });

                expect(called).toBe(true);
                const rows = db.prepare("SELECT * FROM test").all();
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
                        uow.afterCommit(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterCommit(() => { secondCalled = true; });
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
                        uow.afterRollback(() => {
                            throw new Error("first hook fails");
                        });
                        uow.afterRollback(() => { secondCalled = true; });
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
                        uow.afterRollback(() => {
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
                        uow.beforeCommit(() => { throw beforeCommitError; });
                        uow.afterRollback(() => {
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
                        uow.afterCommit(() => {
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
