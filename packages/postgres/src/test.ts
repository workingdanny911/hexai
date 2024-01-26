import { DatabaseManager, TableManager } from "@/helpers";
import {
    parseDatabaseNameFrom,
    replaceDatabaseNameIn,
} from "@hexai/core/utils";
import { runHexaiMigrations } from "@/index";
import { DatabaseError, Client } from "pg";

export function createTestContext(dbUrl: string) {
    const dbName = parseDatabaseNameFrom(dbUrl);
    const databaseManager = new DatabaseManager(
        replaceDatabaseNameIn(dbUrl, "postgres")
    );
    const tableManager = new TableManager(dbUrl);

    async function setup(): Promise<void> {
        try {
            await databaseManager.dropDatabase(dbName);
        } catch (e) {
            if (e instanceof DatabaseError && e.code === "3D000") {
                // ignore
            } else {
                throw e;
            }
        }

        await databaseManager.createDatabase(dbName);
        await runHexaiMigrations(dbUrl);
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
