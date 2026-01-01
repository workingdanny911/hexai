import { Client } from "pg";

import { DatabaseManager, isDatabaseError, TableManager } from "@/helpers";
import { PostgresConfig } from "@/config";
import { runHexaiMigrations } from "@/run-hexai-migrations";

export function createTestContext(dbUrl: string | PostgresConfig) {
    const config =
        typeof dbUrl === "string" ? PostgresConfig.fromUrl(dbUrl) : dbUrl;

    const dbName = config.database;
    const databaseManager = new DatabaseManager(
        config.withDatabase("postgres")
    );
    const tableManager = new TableManager(config);

    async function setup(): Promise<void> {
        try {
            await databaseManager.dropDatabase(dbName);
        } catch (e) {
            if (isDatabaseError(e) && e.code === "3D000") {
                // ignore
            } else {
                throw e;
            }
        }

        await databaseManager.createDatabase(dbName);
        await runHexaiMigrations(config);
    }

    async function teardown(): Promise<void> {
        await tableManager.close();
        await databaseManager.dropDatabase(dbName);
        await databaseManager.close();
    }

    return {
        client: tableManager.getClient(),
        newClient: () => new Client(dbUrl),
        tableManager,
        setup,
        teardown,
    };
}
