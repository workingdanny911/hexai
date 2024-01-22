import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import * as pg from "pg";

import {
    DatabaseManager,
    MigrationManager,
    replaceDatabaseName,
    TableManager,
} from "./helpers";
import { runMigrations } from "src/run-migrations";

const MIGRATIONS_DIR = "test_migrations";
const DATABASE = "test_hexai__running_migration";
const URL = replaceDatabaseName(DATABASE);

describe("running migrations", () => {
    const dbManager = new DatabaseManager(replaceDatabaseName("postgres", URL));
    const conn = new pg.Client(URL);
    const tableManager = new TableManager(conn);
    const migrationManager = new MigrationManager(conn);

    beforeAll(async () => {
        await dbManager.createDatabase(DATABASE);

        return async () => {
            await conn.end();

            await dbManager.dropDatabase(DATABASE);
            await dbManager.close();
        };
    });

    beforeEach(async () => {
        await Promise.all([
            createMigrationsDir(),
            tableManager.dropAllTables(),
        ]);

        return async () => {
            await deleteMigrationsDir();
        };
    });

    async function expectMigrationToBeApplied(
        ...migrations: string[]
    ): Promise<void> {
        const appliedMigrations = await migrationManager.getAppliedMigrations();

        expect(appliedMigrations).toEqual(migrations);
    }

    async function expectTableSchema(
        tableName: string,
        columns: Array<{
            column: string;
            type: string;
        }>
    ): Promise<void> {
        const result = await tableManager.getTableSchema(tableName);

        expect(result).toEqual(columns);
    }

    async function expectTableDoesNotExist(tableName: string): Promise<void> {
        expect(await tableManager.tableExists(tableName)).toBe(false);
    }

    async function migrate({
        dir,
        namespace,
    }: {
        dir?: string;
        namespace?: string;
    } = {}): Promise<void> {
        await runMigrations({
            namespace: namespace ?? "",
            dir: dir ?? MIGRATIONS_DIR,
            url: URL,
        });
    }

    test("when migrations directory does not exist", async () => {
        await expect(migrate({ dir: "non-existing-dir" })).rejects.toThrowError(
            /.*no such file or directory.*/
        );
    });

    test("when migrations directory is empty", async () => {
        await expect(migrate()).rejects.toThrowError(
            /.*no migration files found.*/
        );
    });

    test("when migrations directory contains single migration", async () => {
        await createMigrationFile("1_initial", `CREATE TABLE foo (id INT);`);

        await migrate();

        await expectMigrationToBeApplied("1_initial");
        await expectTableSchema("foo", [
            {
                column: "id",
                type: "integer",
            },
        ]);
    });

    test("namespace", async () => {
        await createMigrationFile("1_initial", `CREATE TABLE foo (id INT);`);

        await migrate({ namespace: "test_migrations" });

        await expectMigrationToBeApplied("test_migrations__1_initial");
        await expectTableSchema("foo", [
            {
                column: "id",
                type: "integer",
            },
        ]);
    });

    test("when migrations directory contains multiple migrations", async () => {
        await createMigrationFile("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigrationFile(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN foo TEXT;`
        );
        await createMigrationFile(
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
                column: "id",
                type: "integer",
            },
            {
                column: "foo",
                type: "text",
            },
            {
                column: "bar",
                type: "text",
            },
        ]);
    });

    test("when migrations directory contains multiple migrations and some of them are already applied", async () => {
        await migrationManager.ensureMigrationTableCreated();
        for (const migration of ["1_initial", "2_add_column"]) {
            await conn.query(
                `INSERT INTO hexai__migrations (name) VALUES ($1);`,
                [migration]
            );
        }

        await createMigrationFile("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigrationFile(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN foo TEXT;`
        );
        await createMigrationFile("3_new_table", `CREATE TABLE bar (id INT);`);

        await migrate();

        await expectMigrationToBeApplied(
            "1_initial",
            "2_add_column",
            "3_new_table"
        );
        await expectTableDoesNotExist("foo");
        await expectTableSchema("bar", [
            {
                column: "id",
                type: "integer",
            },
        ]);
    });

    test("when a migration fails in the middle", async () => {
        await createMigrationFile("1_initial", `CREATE TABLE foo (id INT);`);
        await createMigrationFile("2_invalid", `INVALID SQL STATEMENT`);
        await createMigrationFile(
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

async function createMigrationsDir(): Promise<void> {
    await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
}

async function deleteMigrationsDir(): Promise<void> {
    await fs.rm(MIGRATIONS_DIR, { recursive: true });
}

async function createMigrationFile(name: string, sql: string): Promise<void> {
    await fs.mkdir(`${MIGRATIONS_DIR}/${name}`, { recursive: true });
    await fs.writeFile(`${MIGRATIONS_DIR}/${name}/migration.sql`, sql);
}
