import { DatabaseManager, TableManager } from "@/helpers";
import { getTestConfig } from "@/test-fixtures/config";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { Client } from "pg";

export function getDatabaseManager() {
    return new DatabaseManager(getPostgresUrl());
}

function getPostgresUrl() {
    return getTestConfig().db.withDatabase("postgres");
}

export function useDatabase(
    databaseName: string,
    when: "beforeEach" | "beforeAll" = "beforeAll"
) {
    const dbManager = getDatabaseManager();

    if (when === "beforeAll") {
        beforeAll(async () => {
            await dbManager.createDatabase(databaseName);

            return async () => {
                await dbManager.dropDatabase(databaseName);
                await dbManager.close();
            };
        });
    } else {
        beforeEach(async () => {
            await dbManager.createDatabase(databaseName);

            return async () => {
                await dbManager.dropDatabase(databaseName);
            };
        });

        afterAll(async () => {
            await dbManager.close();
        });
    }

    return getPostgresUrl().withDatabase(databaseName);
}

export function useTableManager(database?: string) {
    const url = getTestConfig().db;
    const manager = new TableManager(
        database ? url.withDatabase(database) : url
    );

    afterAll(async () => {
        await manager.close();
    });

    return manager;
}

export function useClient(
    database?: string,
    when: "beforeEach" | "beforeAll" = "beforeAll"
) {
    const client = newClient(database);

    if (when === "beforeAll") {
        beforeAll(async () => {
            await client.connect();

            return async () => {
                await client.end();
            };
        });
    } else {
        beforeEach(async () => {
            await client.connect();

            return async () => {
                await client.end();
            };
        });
    }

    return client;
}

export function newClient(database?: string) {
    let url = getTestConfig().db;
    if (database) {
        url = url.withDatabase(database);
    }

    return new Client(url.toString());
}
