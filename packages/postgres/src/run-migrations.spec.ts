import fs from "node:fs/promises";
import path from "node:path";

import { beforeEach, describe, expect, test } from "vitest";

import { useClient, useDatabase, useTableManager } from "./test-fixtures/index.js";
import { runMigrations } from "./run-migrations.js";

const MIGRATIONS_DIR = "test_migrations";
const DATABASE = "test_hexai__running_migration";

type TableColumn = {
    column: string;
    type: string;
};

type MigrateOptions = {
    dir?: string;
    namespace?: string;
    direction?: "up" | "down";
    count?: number;
    dryRun?: boolean;
};

function useMigrationTestContext() {
    const url = useDatabase(DATABASE);
    const conn = useClient(DATABASE);
    const tableManager = useTableManager(DATABASE);

    beforeEach(async () => {
        await Promise.all([createMigrationsDir(), tableManager.dropAllTables()]);

        return async () => {
            await deleteMigrationsDir();
        };
    });

    async function migrate({
        dir,
        namespace,
        direction,
        count,
        dryRun,
    }: MigrateOptions = {}): Promise<void> {
        await runMigrations({
            namespace: namespace ?? "",
            dir: dir ? path.join(MIGRATIONS_DIR, dir) : MIGRATIONS_DIR,
            url,
            direction,
            count,
            dryRun,
        });
    }

    async function getAppliedMigrations(tableName: string): Promise<string[]> {
        const result = await conn.query(
            `SELECT name FROM "${tableName}" ORDER BY id ASC`
        );
        return result.rows.map((row) => row.name);
    }

    async function expectMigrationToBeApplied(
        tableName: string,
        ...migrations: string[]
    ): Promise<void> {
        await expect(getAppliedMigrations(tableName)).resolves.toEqual(
            migrations
        );
    }

    async function expectTableSchema(
        tableName: string,
        columns: TableColumn[]
    ): Promise<void> {
        await expect(tableManager.getTableSchema(tableName)).resolves.toEqual(
            columns
        );
    }

    async function expectTableToExist(tableName: string): Promise<void> {
        await expect(tableManager.tableExists(tableName)).resolves.toBe(true);
    }

    async function expectTableDoesNotExist(tableName: string): Promise<void> {
        await expect(tableManager.tableExists(tableName)).resolves.toBe(false);
    }

    async function expectMigrationRowCount(
        tableName: string,
        migrationName: string,
        count: number
    ): Promise<void> {
        const result = await conn.query(
            `SELECT COUNT(*)::int AS count FROM "${tableName}" WHERE name = $1`,
            [migrationName]
        );

        expect(result.rows[0].count).toBe(count);
    }

    async function expectUniqueMigrationNameIndexCount(
        tableName: string,
        count: number
    ): Promise<void> {
        const result = await conn.query(
            `
                SELECT COUNT(*)::int AS count
                FROM pg_indexes
                WHERE schemaname = 'public'
                AND tablename = $1
                AND indexdef LIKE '%UNIQUE%'
                AND indexdef LIKE '%(name)%'
            `,
            [tableName]
        );

        expect(result.rows[0].count).toBe(count);
    }

    async function createMigrationLedgerTable(tableName: string): Promise<void> {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS "${tableName}" (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                run_on TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
    }

    async function createFailingLedgerInsertTrigger(
        tableName: string
    ): Promise<void> {
        const functionName = `${tableName}__fail_insert`;
        const triggerName = `${tableName}__fail_insert_trigger`;

        await conn.query(`
            CREATE OR REPLACE FUNCTION "${functionName}"()
            RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'injected ledger insert failure';
            END;
            $$ LANGUAGE plpgsql;

            CREATE TRIGGER "${triggerName}"
            BEFORE INSERT ON "${tableName}"
            FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
        `);
    }

    async function dropFailingLedgerInsertTrigger(
        tableName: string
    ): Promise<void> {
        const functionName = `${tableName}__fail_insert`;
        const triggerName = `${tableName}__fail_insert_trigger`;

        await conn.query(`
            DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableName}";
            DROP FUNCTION IF EXISTS "${functionName}"();
        `);
    }

    return {
        conn,
        createFailingLedgerInsertTrigger,
        createMigrationLedgerTable,
        dropFailingLedgerInsertTrigger,
        migrate,
        expectMigrationToBeApplied,
        expectMigrationRowCount,
        expectTableDoesNotExist,
        expectTableSchema,
        expectTableToExist,
        expectUniqueMigrationNameIndexCount,
    };
}

describe("running JS-based migrations", () => {
    const {
        conn,
        migrate,
        expectMigrationToBeApplied,
        expectTableDoesNotExist,
        expectTableSchema,
    } = useMigrationTestContext();

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
        await migrate({ direction: "down", count: 1 });

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
        await migrate({ namespace: "legacy" });

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
    const {
        conn,
        createFailingLedgerInsertTrigger,
        createMigrationLedgerTable,
        dropFailingLedgerInsertTrigger,
        migrate,
        expectMigrationToBeApplied,
        expectMigrationRowCount,
        expectTableDoesNotExist,
        expectTableSchema,
        expectTableToExist,
        expectUniqueMigrationNameIndexCount,
    } = useMigrationTestContext();

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

    test("does not write schema or ledger state on dry run", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE dry_run_probe (id INTEGER);`
        );

        await migrate({ dryRun: true });

        await expectTableDoesNotExist("dry_run_probe");
        await expectTableDoesNotExist("hexai__migrations");
    });

    test("does not rewrite legacy ledger columns on dry run", async () => {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS hexai__migrations_dry_legacy (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await conn.query(`
            INSERT INTO hexai__migrations_dry_legacy (name) VALUES ('1_initial')
        `);
        await createSqlMigration(
            "2_add_column",
            `CREATE TABLE dry_legacy_probe (id INTEGER);`
        );

        await migrate({ namespace: "dry_legacy", dryRun: true });

        const columnCheck = await conn.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'hexai__migrations_dry_legacy'
            AND column_name IN ('applied_at', 'run_on')
        `);
        expect(columnCheck.rows.map((row) => row.column_name)).toEqual([
            "applied_at",
        ]);
        await expectTableDoesNotExist("dry_legacy_probe");
    });

    test("rolls back migration SQL when recording the ledger row fails", async () => {
        await createSqlMigration(
            "1_create_probe",
            `CREATE TABLE probe_created_by_migration (id INTEGER PRIMARY KEY);`
        );
        await createMigrationLedgerTable("hexai__migrations");
        await createFailingLedgerInsertTrigger("hexai__migrations");

        try {
            await expect(migrate()).rejects.toThrow(
                /injected ledger insert failure/
            );
            await expectTableDoesNotExist("probe_created_by_migration");
            await expectMigrationToBeApplied("hexai__migrations");
        } finally {
            await dropFailingLedgerInsertTrigger("hexai__migrations");
        }

        await migrate();

        await expectTableSchema("probe_created_by_migration", [
            { column: "id", type: "integer" },
        ]);
        await expectMigrationToBeApplied("hexai__migrations", "1_create_probe");
    });

    test("serializes concurrent runners that use the same namespace", async () => {
        await createSqlMigration(
            "1_create_concurrent_probe",
            `
                CREATE TABLE concurrent_probe (id INTEGER PRIMARY KEY);
                SELECT pg_sleep(0.2);
            `
        );

        await expect(
            Promise.all([
                migrate({ namespace: "race" }),
                migrate({ namespace: "race" }),
            ])
        ).resolves.toEqual([undefined, undefined]);

        await expectTableSchema("concurrent_probe", [
            { column: "id", type: "integer" },
        ]);
        await expectMigrationToBeApplied(
            "hexai__migrations_race",
            "1_create_concurrent_probe"
        );
        await expectMigrationRowCount(
            "hexai__migrations_race",
            "1_create_concurrent_probe",
            1
        );
    });

    test("creates a unique ledger index for migration names", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );

        await migrate();

        await expectUniqueMigrationNameIndexCount("hexai__migrations", 1);
    });

    test("fails before migrating when the ledger has duplicate names", async () => {
        await createMigrationLedgerTable("hexai__migrations_dupes");
        await conn.query(`
            INSERT INTO hexai__migrations_dupes (name)
            VALUES ('1_initial'), ('1_initial')
        `);
        await createSqlMigration(
            "2_after_duplicate",
            `CREATE TABLE should_not_run (id INTEGER);`
        );

        await expect(migrate({ namespace: "dupes" })).rejects.toThrow(
            /Duplicate migration records found in hexai__migrations_dupes: 1_initial/
        );
        await expectTableDoesNotExist("should_not_run");
        await expectUniqueMigrationNameIndexCount(
            "hexai__migrations_dupes",
            0
        );
    });

    test("keeps completed SQL migrations when a later migration fails", async () => {
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );
        await createSqlMigration(
            "2_invalid",
            `
                CREATE TABLE failed_probe (id INTEGER);
                INVALID SQL STATEMENT;
            `
        );
        await createSqlMigration(
            "3_add_column",
            `ALTER TABLE foo ADD COLUMN name TEXT;`
        );

        await expect(migrate()).rejects.toThrow();

        await expectTableToExist("foo");
        await expectTableDoesNotExist("failed_probe");
        await expectMigrationToBeApplied("hexai__migrations", "1_initial");
    });

    test("supports legacy applied_at ledgers for SQL migrations", async () => {
        await conn.query(`
            CREATE TABLE IF NOT EXISTS hexai__migrations_sql_legacy (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await conn.query(`
            INSERT INTO hexai__migrations_sql_legacy (name) VALUES ('1_initial')
        `);
        await conn.query(`
            CREATE TABLE foo (id INTEGER)
        `);
        await createSqlMigration(
            "1_initial",
            `CREATE TABLE foo (id INTEGER);`
        );
        await createSqlMigration(
            "2_add_column",
            `ALTER TABLE foo ADD COLUMN bar TEXT;`
        );

        await migrate({ namespace: "sql_legacy" });

        const columnCheck = await conn.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'hexai__migrations_sql_legacy'
            AND column_name IN ('applied_at', 'run_on')
        `);
        expect(columnCheck.rows.map((row) => row.column_name)).toContain(
            "run_on"
        );
        await expectMigrationToBeApplied(
            "hexai__migrations_sql_legacy",
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
