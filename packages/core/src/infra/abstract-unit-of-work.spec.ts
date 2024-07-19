import { Database } from "sqlite";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { SqliteUnitOfWork, useSqliteFileDatabase } from "@/test";
import { EntryRepository } from "@/fixtures";
import { Propagation, UnitOfWorkAbortedError } from "./unit-of-work";
import { verbose } from "sqlite3";

verbose();

function ignoringErrors(fn: () => Promise<void>) {
    return async () => {
        try {
            await fn();
        } catch {
            // ignore
        }
    };
}

function dbHelper(runner: Database) {
    return new EntryRepository(runner);
}

describe("AbstractUnitOfWork: driven by SqliteUnitOfWork", () => {
    const newConn = useSqliteFileDatabase("./abstract-unit-of-work.sqlite");
    const uow = new SqliteUnitOfWork(newConn, async (conn) => conn.close());
    let db: EntryRepository;

    beforeAll(async () => {
        const adminConn = await newConn();

        db = dbHelper(adminConn);
        await db.createTable();
    });

    beforeEach(async () => {
        await db.reset();
    });

    let onTheOutside: EntryRepository;

    beforeEach(async () => {
        onTheOutside = dbHelper(await newConn());
    });

    function doInNestedUow<T>(
        fn: (runner: Database) => Promise<T>,
        propagation: Propagation
    ): Promise<T> {
        return uow.wrap((runner) => fn(runner), {
            propagation,
        });
    }

    async function insertEntryInNestedUow(
        value: string,
        propagation: Propagation
    ) {
        return doInNestedUow(
            (runner) => dbHelper(runner).insertEntry(value),
            propagation
        );
    }

    test("successful execution of wrapped function, results in committed state", async () => {
        const entryId = await uow.wrap(async (runner) => {
            return await dbHelper(runner).insertEntry("test");
        });

        const entry = await onTheOutside.getEntryById(entryId);
        expect(entry.value).toBe("test");
    });

    test("transaction is rolled back when an error is thrown inside of fn", async () => {
        const failingExecute = uow.wrap(async (runner) => {
            await dbHelper(runner).insertEntry("test");

            throw new Error("rollback");
        });

        await expect(failingExecute).rejects.toThrowError("rollback");

        const noEntries = (await onTheOutside.count()) === 0;
        expect(noEntries).toBe(true);
    });

    describe("rollback behavior", () => {
        async function failingNestedUow(propagation: Propagation) {
            return doInNestedUow(
                ignoringErrors(() => {
                    throw new Error("nested rollback");
                }),
                propagation
            );
        }

        test("using propagation EXISTING: when child uow rolls back, the transaction is closed", async () => {
            await ignoringErrors(() =>
                uow.wrap(async () => {
                    await failingNestedUow(Propagation.EXISTING);

                    const work = () =>
                        insertEntryInNestedUow("test", Propagation.EXISTING);
                    await expect(work).rejects.toThrowError(
                        UnitOfWorkAbortedError
                    );
                })
            );
        });

        test("using propagation NESTED: the transaction is alive even though child uow rolls back", async () => {
            await uow.wrap(async () => {
                await failingNestedUow(Propagation.NESTED);

                const entryId = await insertEntryInNestedUow(
                    "test",
                    Propagation.NESTED
                );
                expect(entryId).toBeGreaterThan(0);
            });
        });

        test("using propagation NESTED: only the changes in the error-thrown uow are rolled back", async () => {
            await uow.wrap(async () => {
                await insertEntryInNestedUow("1", Propagation.NESTED);

                await failingNestedUow(Propagation.NESTED);

                await insertEntryInNestedUow("2", Propagation.NESTED);
            });

            const firstAndThirdAreCommitted =
                (await onTheOutside.count()) === 2;
            expect(firstAndThirdAreCommitted).toBe(true);
        });
    });
});
