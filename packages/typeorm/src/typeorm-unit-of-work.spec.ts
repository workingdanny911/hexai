import { unlink } from "node:fs/promises";
import "reflect-metadata";
import {
    BaseEntity,
    Column,
    DataSource,
    Entity,
    PrimaryGeneratedColumn,
    QueryRunner,
} from "typeorm";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Propagation, UnitOfWorkAbortedError } from "@hexai/core";

import { TypeormUnitOfWork } from "./typeorm-unit-of-work";

@Entity()
class Entry extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    value!: string;
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

async function deleteFile(path: string) {
    try {
        await unlink(path);
    } catch (e) {
        if ((e as any)?.code !== "ENOENT") {
            throw e;
        }
    }
}

class EntryRepository {
    async add(value: string): Promise<number> {
        const result = await Entry.insert({ value });
        console.log(result);

        return result.identifiers[0].id;
    }

    async getById(id: number): Promise<Entry> {
        const entry = await Entry.findOne({
            where: { id },
        });

        if (!entry) {
            throw new Error("Entry not found");
        }

        return entry;
    }

    async count(): Promise<number> {
        return Entry.count();
    }
}

// in case of typeorm, we don't need to pass the runner to the repository,
// but for the sake of consistency with other tests, we will pass/receive it
function repository(runner?: QueryRunner) {
    return new EntryRepository();
}

const FILENAME = "./typeorm-uow.sqlite";

describe("TypeormUnitOfWork", () => {
    const dataSource = new DataSource({
        type: "sqlite",
        database: FILENAME,
        entities: [Entry],
    });
    const uow = new TypeormUnitOfWork(dataSource);
    const onTheOutside = repository();

    beforeAll(async () => {
        await dataSource.initialize();

        await dataSource.synchronize(true);

        return async () => {
            await dataSource.dropDatabase();
            await dataSource.destroy();

            await deleteFile(FILENAME);
        };
    });

    beforeEach(async () => {
        await Entry.delete({});
    });

    function doInNestedUow<T>(
        fn: (runner: QueryRunner) => Promise<T>,
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
