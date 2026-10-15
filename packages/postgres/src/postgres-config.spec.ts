import { describe, expect, test } from "vitest";

import {
    createPostgresUnitOfWork,
    DatabaseManager,
    PostgresConfig,
    TableManager,
} from "./index.js";
import { useDatabase } from "./test-fixtures/index.js";

const DATABASE = "test_hexai__postgres_config";

// The PostgresConfig that users import from the package entry, not a class
// reached through an internal path.
describe("PostgresConfig from the package entry", () => {
    const url = useDatabase(DATABASE);
    const config = () => PostgresConfig.fromUrl(url.toString());

    test("configures a unit of work", async () => {
        const uow = createPostgresUnitOfWork(config());

        const result = await uow.db.query<{ answer: number }>(
            "SELECT 1 AS answer"
        );

        expect(result.rows).toEqual([{ answer: 1 }]);
    });

    test("configures a database manager", async () => {
        const manager = new DatabaseManager(config());
        try {
            await expect(manager.query("SELECT 1 AS answer")).resolves.toEqual([
                { answer: 1 },
            ]);
        } finally {
            await manager.close();
        }
    });

    test("configures a table manager", async () => {
        const manager = new TableManager(config());
        try {
            await expect(manager.tableExists("missing_table")).resolves.toBe(
                false
            );
        } finally {
            await manager.close();
        }
    });
});
