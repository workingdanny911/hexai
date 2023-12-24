import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import * as pg from "pg";

import { runMigration } from "./run-migration";
import {
    createClient,
    createDatabase,
    createMigrationsTable,
    createPrivilegedClient,
    dropDatabase,
    getAppliedMigrations,
    replaceDatabaseName,
} from "../helpers";

const MIGRATIONS_DIR = "test_migrations";

async function createMigrationsDir(): Promise<void> {
    await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
}

async function deleteMigrationsDir(): Promise<void> {
    await fs.rm(MIGRATIONS_DIR, { recursive: true });
}

async function createMigration(name: string, sql: string): Promise<void> {
    await fs.mkdir(`${MIGRATIONS_DIR}/${name}`, { recursive: true });
    await fs.writeFile(`${MIGRATIONS_DIR}/${name}/migration.sql`, sql);
}

async function deleteAllTables(client: pg.Client): Promise<void> {
    const result = await client.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
    `);

    await Promise.all(
        result.rows.map(async (row) => {
            await client.query(`DROP TABLE ${row.table_name} CASCADE;`);
        })
    );
}

describe("running migration", () => {
    const database = "test_hexai__running_migration";
    const url = replaceDatabaseName(database);

    let privilegedClient: pg.Client;
    let client: pg.Client;

    beforeAll(async () => {
        privilegedClient = await createPrivilegedClient(url);
        await createDatabase(database, privilegedClient);
        client = await createClient(url);

        return async () => {
            await client.end();
            await dropDatabase(database, privilegedClient);
            await privilegedClient.end();
        };
    });

    beforeEach(async () => {
        await Promise.all([createMigrationsDir(), deleteAllTables(client)]);

        return async () => {
            await deleteMigrationsDir();
        };
    });

    async function expectMigrationToBeApplied(
        ...migrations: string[]
    ): Promise<void> {
        const appliedMigrations = await getAppliedMigrations(client);

        expect(appliedMigrations).toEqual(migrations);
    }

    async function expectTableSchema(
        tableName: string,
        schema: Array<{
            column_name: string;
            data_type: string;
        }>
    ): Promise<void> {
        const result = await client.query(`
            SELECT
                column_name, data_type
            FROM information_schema.columns
            WHERE table_name = '${tableName}';
        `);

        expect(result.rows).toEqual(schema);
    }

    async function expectTableDoesNotExist(tableName: string): Promise<void> {
        const result = await client.query(`
            SELECT
                table_name
            FROM information_schema.tables
            WHERE table_name = '${tableName}';
        `);

        expect(result.rows.length).toEqual(0);
    }

    async function migrate(dir?: string): Promise<void> {
        await runMigration(dir || MIGRATIONS_DIR, url);
    }

    test("when migrations directory does not exist", async () => {
        await expect(migrate("non-existing-dir")).rejects.toThrowError(
            /.*no such file or directory.*/
        );
    });

    test("when migrations directory is empty", async () => {
        await expect(migrate()).rejects.toThrowError(
            /.*no migration files found.*/
        );
    });

    test("when migrations directory contains single migration", async () => {
        await createMigration("1_initial", `CREATE TABLE foo (id INT);`);

        await migrate();

        await expectMigrationToBeApplied("1_initial");
        await expectTableSchema("foo", [
            {
                column_name: "id",
                data_type: "integer",
            },
        ]);
    });

    test("when migrations directory contains multiple migrations", async () => {
        await createMigration("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN foo TEXT;`
        );
        await createMigration(
            "3_add_column",
            `ALTER TABLE foo ADD COLUMN bar TEXT;`
        );

        await migrate();

        await expectMigrationToBeApplied(
            "1_initial",
            "2_add_column",
            "3_add_column"
        );
        await expectTableSchema("foo", [
            {
                column_name: "id",
                data_type: "integer",
            },
            {
                column_name: "foo",
                data_type: "text",
            },
            {
                column_name: "bar",
                data_type: "text",
            },
        ]);
    });

    test("when migrations directory contains multiple migrations and some of them are already applied", async () => {
        await createMigrationsTable(client);
        await createMigration("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN foo TEXT;`
        );
        await createMigration("3_new_table", `CREATE TABLE bar (id INT);`);
        const result = await client.query(`
            INSERT INTO "hexai__migrations" (name) VALUES ('1_initial'), ('2_add_column')
        `);

        await migrate();

        await expectMigrationToBeApplied(
            "1_initial",
            "2_add_column",
            "3_new_table"
        );
        await expectTableDoesNotExist("foo");
        await expectTableSchema("bar", [
            {
                column_name: "id",
                data_type: "integer",
            },
        ]);
    });

    test("when a migration fails in the middle", async () => {
        await createMigration("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigration("2_invalid", `INVALID SQL STATEMENT`);
        await createMigration(
            "3_add_column",
            `ALTER TABLE foo ADD COLUMN bar TEXT;`
        );

        try {
            await migrate();
        } catch (e) {
            // ignore
        }

        // no migrations should be applied
        await expectMigrationToBeApplied();
        await expectTableDoesNotExist("foo");
    });
});
