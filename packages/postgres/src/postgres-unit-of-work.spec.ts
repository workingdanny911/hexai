import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Client } from "pg";
import { Propagation, UnitOfWorkAbortedError } from "@hexai/core";

import { PostgresUnitOfWork } from "./postgres-unit-of-work";
import { DatabaseManager, replaceDatabaseName, TableManager } from "./helpers";
import { DB_URL } from "./config";

const DATABASE = "hexai__test_uow";
const URL = replaceDatabaseName(DATABASE, DB_URL);

interface Entry {
    id: number;
    value: string;
}

class EntryRepository {
    private static TABLE_NAME = "entries";

    constructor(private client: Client) {}

    public static async setup(client: Client) {
        await new TableManager(client).createTable(EntryRepository.TABLE_NAME, [
            {
                name: "id",
                property: "SERIAL PRIMARY KEY",
            },
            {
                name: "value",
                property: "TEXT",
            },
        ]);
    }

    static async reset(client: Client) {
        await new TableManager(client).truncateTable(
            EntryRepository.TABLE_NAME
        );
    }

    async add(value: Entry["value"]): Promise<Entry["id"]> {
        const id = await this.client.query(
            `INSERT INTO ${EntryRepository.TABLE_NAME} (value) VALUES ($1) RETURNING id`,
            [value]
        );

        return id.rows[0].id;
    }

    async getById(id: Entry["id"]): Promise<Entry> {
        const result = await this.client.query(
            `SELECT * FROM ${EntryRepository.TABLE_NAME} WHERE id = $1`,
            [id]
        );

        if (!result) {
            throw new Error(`Entry with id ${id} not found`);
        }

        return result.rows[0];
    }

    async count(): Promise<number> {
        const result = await this.client.query(
            `SELECT COUNT(*) FROM ${EntryRepository.TABLE_NAME}`
        );

        return parseInt(result.rows[0].count);
    }
}

function repository(client: Client) {
    return new EntryRepository(client);
}

function ignoringErrors(fn: () => Promise<void>) {
    return async () => {
        try {
            await fn();
        } catch {
            // ignore
        }
    };
}

describe("PostgreSQL unit of work", () => {
    const dbManager = new DatabaseManager(replaceDatabaseName("postgres", URL));
    const connOnTheOutside = new Client(URL);
    const orthagonalRepository = repository(connOnTheOutside);
    const uow = new PostgresUnitOfWork(
        () => new Client(URL),
        (conn) => conn.end()
    );

    beforeAll(async () => {
        await dbManager.createDatabase(DATABASE);

        await connOnTheOutside.connect();
        await EntryRepository.setup(connOnTheOutside);

        return async () => {
            await connOnTheOutside.end();

            await dbManager.dropDatabase(DATABASE);
            await dbManager.close();
        };
    });

    beforeEach(async () => {
        await EntryRepository.reset(connOnTheOutside);
    });

    function doInNestedUow<T>(
        fn: (runner: Client) => Promise<T>,
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

        const entry = await orthagonalRepository.getById(entryId);
        expect(entry.value).toBe("test");
    });

    test("transaction is rolled back when an error is thrown inside of fn", async () => {
        const failingExecute = uow.wrap(async (runner) => {
            await repository(runner).add("test");

            throw new Error("rollback");
        });

        await expect(failingExecute).rejects.toThrowError("rollback");

        const noEntries = (await orthagonalRepository.count()) === 0;
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
                (await orthagonalRepository.count()) === 2;
            expect(firstAndThirdAreCommitted).toBe(true);
        });
    });
});
