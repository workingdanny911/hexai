import { beforeEach, describe, expect, it, test } from "vitest";
import { Database, open } from "sqlite";

import { DuplicateObjectError } from "@/domain";
import { Counter, CounterId, CounterMemento } from "@/test";
import { SqliteRepository } from "@/test/sqlite/sqlite-repository";

describe("SqliteRepository", () => {
    let db: Database;
    let repository: SqliteRepository<Counter, CounterMemento>;

    beforeEach(async () => {
        db = await open({
            filename: ":memory:",
            driver: require("sqlite3").Database,
        });
        repository = new SqliteRepository<Counter, CounterMemento>(db, {
            namespace: "counter",
            hydrate: (m) => Counter.fromMemento(m),
            dehydrate: (c) => c.toMemento(),
        });

        return async () => {
            await db.close();
        };
    });

    async function isTableCreated(name: string): Promise<boolean> {
        const rows = await db.all(
            `SELECT * FROM sqlite_master WHERE name = 'counter'`
        );

        return !!rows.find((row) => row.type === "table" && row.name === name);
    }

    it.each([
        {
            description: "get()",
            operation: () => repository.get(new CounterId("counter")),
        },
        {
            description: "add()",
            operation: () =>
                repository.add(
                    Counter.fromMemento({ id: "counter", value: 0 })
                ),
        },
        {
            description: "update()",
            operation: () =>
                repository.update(
                    Counter.fromMemento({ id: "counter", value: 0 })
                ),
        },
        { description: "count()", operation: () => repository.count() },
    ])(
        "creates a new table if it does not exist - $description",
        async ({ operation }) => {
            await expect(isTableCreated("counter")).resolves.toBe(false);

            try {
                await operation();
            } catch {}

            await expect(isTableCreated("counter")).resolves.toBe(true);
        }
    );

    test("adding", async () => {
        const counter = Counter.fromMemento({ id: "counter-id", value: 0 });

        await repository.add(counter);

        const [row] = await db.all(`SELECT * FROM counter`);
        expect(row).toEqual({
            id: "counter-id",
            data: JSON.stringify(counter.toMemento()),
        });
    });

    test("id is unique", async () => {
        const counter = Counter.fromMemento({ id: "counter-id", value: 0 });
        await repository.add(counter);

        await expect(
            repository.add(
                Counter.fromMemento({
                    id: "counter-id",
                    value: 100,
                })
            )
        ).rejects.toThrowError(DuplicateObjectError);
    });

    test("updating", async () => {
        const counter = Counter.fromMemento({ id: "counter-id", value: 0 });
        await repository.add(counter);

        counter.increment();
        await repository.update(counter);

        const [row] = await db.all(`SELECT * FROM counter`);
        expect(row).toEqual({
            id: "counter-id",
            data: JSON.stringify(counter.toMemento()),
        });
    });

    test("updating non-existing", async () => {
        const counter = Counter.fromMemento({ id: "counter-id", value: 0 });

        await expect(repository.update(counter)).rejects.toThrowError();
    });

    test("getting", async () => {
        await repository.add(
            Counter.fromMemento({ id: "counter-id", value: 0 })
        );

        const result = await repository.get(new CounterId("counter-id"));

        expect(result.getId().getValue()).toBe("counter-id");
        expect(result.getValue()).toBe(0);
    });

    test("getting non-existing", async () => {
        await expect(
            repository.get(new CounterId("counter-id"))
        ).rejects.toThrowError();
    });

    test("counting", async () => {
        await expect(repository.count()).resolves.toBe(0);

        await repository.add(
            Counter.fromMemento({ id: "counter-id", value: 0 })
        );

        await expect(repository.count()).resolves.toBe(1);
    });
});
