import { beforeEach, describe, expect } from "vitest";

import { getSqliteConnection, SqliteUnitOfWork } from "./sqlite";

import { makeTransactionalTest } from "./transactional-test";

describe("Transactional test", () => {
    let uow: SqliteUnitOfWork;
    const test = makeTransactionalTest(async () => {
        const connection = await getSqliteConnection();
        uow = new SqliteUnitOfWork(connection);
        return uow;
    });

    test("tests are run in a transaction", async () => {
        expect(() => uow.getClient()).not.toThrow();
    });
});
