import { Database } from "sqlite";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";

import { SqliteUnitOfWork, useSqliteFileDatabase } from "@/test";
import { EntryRepository } from "@/fixtures";
import { Propagation, UnitOfWorkAbortedError } from "./unit-of-work";

function ignoringErrors(fn: () => Promise<void>) {
    return async () => {
        try {
            await fn();
        } catch {
            // ignore
        }
    };
}

function repository(runner: Database) {
    return new EntryRepository(runner);
}

describe("AbstractUnitOfWork: driven by SqliteUnitOfWork", () => {
    const newConn = useSqliteFileDatabase("./abstract-unit-of-work.sqlite");
    const uow = new SqliteUnitOfWork(newConn, async (conn) => conn.close());
    let connForSetup: Database;
    let onTheOutside: EntryRepository;

    beforeAll(async () => {
        connForSetup = await newConn();
        await repository(connForSetup).createTable();
    });

    beforeEach(async () => {
        await repository(connForSetup).reset();

        onTheOutside = repository(await newConn());
    });

    function doInNestedUow<T>(
        fn: (runner: Database) => Promise<T>,
        propagation: Propagation
    ): Promise<T> {
        return uow.wrap((runner) => fn(runner), {
            propagation,
        });
    }

    async function addEntryInNestedUow(
        value: string,
        propagation: Propagation
    ) {
        return doInNestedUow(
            (runner) => repository(runner).add(value),
            propagation
        );
    }

    test("successful execution of wrapped function, results in committed state", async () => {
        const entryId = await uow.wrap(async (runner) => {
            return await repository(runner).add("test");
        });

        const entry = await onTheOutside.getById(entryId);
        expect(entry.value).toBe("test");
    });

    test("transaction is rolled back when an error is thrown inside of fn", async () => {
        const failingExecute = uow.wrap(async (runner) => {
            await repository(runner).add("test");

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
                        addEntryInNestedUow("test", Propagation.EXISTING);
                    await expect(work).rejects.toThrowError(
                        UnitOfWorkAbortedError
                    );
                })
            );
        });

        test("using propagation NESTED: the transaction is alive even though child uow rolls back", async () => {
            await uow.wrap(async () => {
                await failingNestedUow(Propagation.NESTED);

                const entryId = await addEntryInNestedUow(
                    "test",
                    Propagation.NESTED
                );
                expect(entryId).toBeGreaterThan(0);
            });
        });

        test("using propagation NESTED: only the changes in the error-thrown uow are rolled back", async () => {
            await uow.wrap(async () => {
                await addEntryInNestedUow("1", Propagation.NESTED);

                await failingNestedUow(Propagation.NESTED);

                await addEntryInNestedUow("2", Propagation.NESTED);
            });

            const firstAndThirdAreCommitted =
                (await onTheOutside.count()) === 2;
            expect(firstAndThirdAreCommitted).toBe(true);
        });
    });
});
