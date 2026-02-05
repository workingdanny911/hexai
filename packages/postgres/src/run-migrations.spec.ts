import path from "node:path";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, test } from "vitest";

import { useClient, useDatabase, useTableManager } from "@/test-fixtures";
import { runMigrations } from "./run-migrations";

const MIGRATIONS_DIR = "test_migrations";
const DATABASE = "test_hexai__running_migration";

describe("running JS-based migrations", () => {
    const url = useDatabase(DATABASE);
    const conn = useClient(DATABASE);
    const tableManager = useTableManager(DATABASE);

    beforeEach(async () => {
        await Promise.all([
            createMigrationsDir(),
            tableManager.dropAllTables(),
        ]);

        return async () => {
            await deleteMigrationsDir();
        };
    });

    async function getAppliedMigrations(tableName: string): Promise<string[]> {
        const result = await conn.query(
            `SELECT name FROM "${tableName}" ORDER BY run_on ASC`
        );
        return result.rows.map((row) => row.name);
    }

    async function expectMigrationToBeApplied(
        tableName: string,
        ...migrations: string[]
    ): Promise<void> {
        const appliedMigrations = await getAppliedMigrations(tableName);
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
            dir: dir ? path.join(MIGRATIONS_DIR, dir) : MIGRATIONS_DIR,
            url,
        });
    }

    test("when migrating with different directories and namespace", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`,
            "package_a"
        );
        await createJsMigration(
            "1_initial",
            `pgm.createTable("bar", { id: { type: "integer" } });`,
            `pgm.dropTable("bar");`,
            "package_b"
        );
        await createJsMigration(
            "2_add_column",
            `pgm.addColumns("bar", { bar: { type: "text" } });`,
            `pgm.dropColumns("bar", ["bar"]);`,
            "package_b"
        );

        await migrate({
            dir: "package_a",
            namespace: "package_a",
        });
        await migrate({
            dir: "package_b",
            namespace: "package_b",
        });

        await expectMigrationToBeApplied(
            "hexai__migrations_package_a",
            "1_initial"
        );
        await expectMigrationToBeApplied(
            "hexai__migrations_package_b",
            "1_initial",
            "2_add_column"
        );
    });

    test("when migrations directory does not exist", async () => {
        await expect(migrate({ dir: "non-existing-dir" })).rejects.toThrowError(
            /.*no such file or directory.*/
        );
    });

    test("when migrations directory contains single migration", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );

        await migrate();

        await expectMigrationToBeApplied("hexai__migrations", "1_initial");
        await expectTableSchema("foo", [
            {
                column: "id",
                type: "integer",
            },
        ]);
    });

    test("namespace", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );

        await migrate({ namespace: "test_migrations" });

        await expectMigrationToBeApplied(
            "hexai__migrations_test_migrations",
            "1_initial"
        );
        await expectTableSchema("foo", [
            {
                column: "id",
                type: "integer",
            },
        ]);
    });

    test("when migrations directory contains multiple migrations", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );
        await createJsMigration(
            "2_add_column",
            `pgm.addColumns("foo", { foo: { type: "text" } });`,
            `pgm.dropColumns("foo", ["foo"]);`
        );
        await createJsMigration(
            "3_add_column",
            `pgm.addColumns("foo", { bar: { type: "text" } });`,
            `pgm.dropColumns("foo", ["bar"]);`
        );

        await migrate();

        await expectMigrationToBeApplied(
            "hexai__migrations",
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

    test("when a migration fails in the middle", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );
        await createJsMigration(
            "2_invalid",
            `pgm.sql("INVALID SQL STATEMENT");`,
            ``
        );
        await createJsMigration(
            "3_add_column",
            `pgm.addColumns("foo", { bar: { type: "text" } });`,
            `pgm.dropColumns("foo", ["bar"]);`
        );

        try {
            await migrate();
        } catch (e) {
            // ignore
        }

        // no migrations should be applied (rolled back)
        await expectMigrationToBeApplied("hexai__migrations");
        await expectTableDoesNotExist("foo");
    });

    test("rollback migration", async () => {
        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );

        await migrate();
        await expectTableSchema("foo", [{ column: "id", type: "integer" }]);

        // Rollback
        await runMigrations({
            dir: MIGRATIONS_DIR,
            url,
            direction: "down",
            count: 1,
        });

        await expectTableDoesNotExist("foo");
    });

    test("backward compatibility - auto migrate applied_at to run_on", async () => {
        // Create old-style migration table with applied_at column
        await conn.query(`
            CREATE TABLE IF NOT EXISTS hexai__migrations_legacy (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        // Record 1_initial as already applied
        await conn.query(`
            INSERT INTO hexai__migrations_legacy (name) VALUES ('1_initial')
        `);
        // Also create the foo table since 1_initial was "already run"
        await conn.query(`
            CREATE TABLE foo (id INTEGER)
        `);

        await createJsMigration(
            "1_initial",
            `pgm.createTable("foo", { id: { type: "integer" } });`,
            `pgm.dropTable("foo");`
        );
        await createJsMigration(
            "2_add_column",
            `pgm.addColumns("foo", { bar: { type: "text" } });`,
            `pgm.dropColumns("foo", ["bar"]);`
        );

        // Run migration - should auto-convert applied_at to run_on
        await runMigrations({
            url,
            dir: MIGRATIONS_DIR,
            namespace: "legacy",
        });

        // Check that column was renamed
        const columnCheck = await conn.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'hexai__migrations_legacy'
            AND column_name IN ('applied_at', 'run_on')
        `);
        expect(columnCheck.rows.map((r) => r.column_name)).toContain("run_on");

        // Only the new migration should be applied (1_initial was already recorded)
        await expectMigrationToBeApplied(
            "hexai__migrations_legacy",
            "1_initial",
            "2_add_column"
        );
    });
});

describe("running SQL-based migrations", () => {
    const url = useDatabase(DATABASE);
    const conn = useClient(DATABASE);
    const tableManager = useTableManager(DATABASE);

    beforeEach(async () => {
        await Promise.all([
            createMigrationsDir(),
            tableManager.dropAllTables(),
        ]);

        return async () => {
            await deleteMigrationsDir();
        };
    });

    async function getAppliedMigrations(tableName: string): Promise<string[]> {
        const result = await conn.query(
            `SELECT name FROM "${tableName}" ORDER BY run_on ASC`
        );
        return result.rows.map((row) => row.name);
    }

    async function expectMigrationToBeApplied(
        tableName: string,
        ...migrations: string[]
    ): Promise<void> {
        const appliedMigrations = await getAppliedMigrations(tableName);
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
            dir: dir ? path.join(MIGRATIONS_DIR, dir) : MIGRATIONS_DIR,
            url,
        });
    }

    test("single migration", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );

        await migrate();

        await expectMigrationToBeApplied("hexai__migrations", "1_initial");
        await expectTableSchema("foo", [
            { column: "id", type: "integer" },
        ]);
    });

    test("multiple migrations", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );
        await createSqlMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN name TEXT;`
        );
        await createSqlMigration(
            "3_add_column",
            `ALTER TABLE foo ADD COLUMN email TEXT;`
        );

        await migrate();

        await expectMigrationToBeApplied(
            "hexai__migrations",
            "1_initial",
            "2_add_column",
            "3_add_column"
        );
        await expectTableSchema("foo", [
            { column: "id", type: "integer" },
            { column: "name", type: "text" },
            { column: "email", type: "text" },
        ]);
    });

    test("numeric sorting (1, 2, 10 order)", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );
        await createSqlMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN col2 TEXT;`
        );
        await createSqlMigration(
            "10_add_column",
            `ALTER TABLE foo ADD COLUMN col10 TEXT;`
        );

        await migrate();

        // Should be sorted numerically: 1, 2, 10 (not lexicographically: 1, 10, 2)
        await expectMigrationToBeApplied(
            "hexai__migrations",
            "1_initial",
            "2_add_column",
            "10_add_column"
        );
        await expectTableSchema("foo", [
            { column: "id", type: "integer" },
            { column: "col2", type: "text" },
            { column: "col10", type: "text" },
        ]);
    });

    test("namespace", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );

        await migrate({ namespace: "my_app" });

        await expectMigrationToBeApplied(
            "hexai__migrations_my_app",
            "1_initial"
        );
    });

    test("skips already applied migrations", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );

        await migrate();
        await expectMigrationToBeApplied("hexai__migrations", "1_initial");

        // Add new migration
        await createSqlMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN name TEXT;`
        );

        await migrate();

        // Both should be recorded, but 1_initial was not re-run
        await expectMigrationToBeApplied(
            "hexai__migrations",
            "1_initial",
            "2_add_column"
        );
    });

    test("different directories with namespace", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`,
            "package_a"
        );
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE bar (id INTEGER);`,
            "package_b"
        );

        await migrate({ dir: "package_a", namespace: "package_a" });
        await migrate({ dir: "package_b", namespace: "package_b" });

        await expectMigrationToBeApplied(
            "hexai__migrations_package_a",
            "1_initial"
        );
        await expectMigrationToBeApplied(
            "hexai__migrations_package_b",
            "1_initial"
        );
        await expectTableSchema("foo", [{ column: "id", type: "integer" }]);
        await expectTableSchema("bar", [{ column: "id", type: "integer" }]);
    });
});

async function createMigrationsDir(): Promise<void> {
    await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
}

async function deleteMigrationsDir(): Promise<void> {
    await fs.rm(MIGRATIONS_DIR, { recursive: true });
}

async function createJsMigration(
    name: string,
    upCode: string,
    downCode: string,
    subDir?: string
): Promise<void> {
    const dir = subDir ? `${MIGRATIONS_DIR}/${subDir}` : MIGRATIONS_DIR;
    await fs.mkdir(dir, { recursive: true });

    const content = `
exports.up = (pgm) => {
    ${upCode}
};

exports.down = (pgm) => {
    ${downCode}
};
`;
    await fs.writeFile(`${dir}/${name}.cjs`, content);
}

async function createSqlMigration(
    name: string,
    sql: string,
    subDir?: string
): Promise<void> {
    const baseDir = subDir ? `${MIGRATIONS_DIR}/${subDir}` : MIGRATIONS_DIR;
    const migrationDir = `${baseDir}/${name}`;
    await fs.mkdir(migrationDir, { recursive: true });
    await fs.writeFile(`${migrationDir}/migration.sql`, sql);
}
