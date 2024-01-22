import { beforeEach, describe, expect, test } from "vitest";
import { Database, open } from "sqlite";

import { SqliteUnitOfWork } from "./sqlite-unit-of-work";

describe("unit of work", () => {
    let db: Database;
    let uow: SqliteUnitOfWork;

    beforeEach(async () => {
        db = await open({
            filename: ":memory:",
            driver: require("sqlite3").Database,
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
});
