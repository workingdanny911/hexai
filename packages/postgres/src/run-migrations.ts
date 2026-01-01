import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as pg from "pg";
import runner from "node-pg-migrate";
import { PostgresConfig } from "@/config";

/**
 * Extracts numeric prefix from migration filename for proper sorting.
 * Handles both simple numeric prefixes (1_initial) and timestamps (1734567890123_initial).
 */
function extractNumericPrefix(filename: string): number {
    const match = filename.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

export interface MigrationOptions {
    url: PostgresConfig | string;
    dir: string;
    namespace?: string;
    direction?: "up" | "down";
    count?: number;
    dryRun?: boolean;
}

/**
 * Ensures backward compatibility with existing tables that have 'applied_at' column
 * by renaming it to 'run_on' (node-pg-migrate's expected column name)
 */
async function ensureTableCompatibility(
    client: pg.Client,
    tableName: string
): Promise<void> {
    // Check if table exists
    const tableExists = await client.query(
        `
        SELECT 1 FROM information_schema.tables
        WHERE table_name = $1
    `,
        [tableName]
    );

    if (tableExists.rows.length === 0) return;

    // Check if applied_at column exists (old schema)
    const hasAppliedAt = await client.query(
        `
        SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'applied_at'
    `,
        [tableName]
    );

    if (hasAppliedAt.rows.length > 0) {
        await client.query(`
            ALTER TABLE "${tableName}"
            RENAME COLUMN applied_at TO run_on
        `);
        console.log(`Migrated table ${tableName}: applied_at → run_on`);
    }
}

/**
 * Detects whether the migrations directory contains SQL-based migrations
 * (directories with migration.sql files) or JavaScript-based migrations.
 */
async function isSqlMigrationFormat(dir: string): Promise<boolean> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sqlPath = path.join(dir, entry.name, "migration.sql");
                try {
                    await fs.access(sqlPath);
                    return true;
                } catch {
                    // Not a SQL migration directory
                }
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Runs SQL-based migrations (directories with migration.sql files)
 */
async function runSqlMigrations(
    client: pg.Client,
    dir: string,
    migrationsTable: string,
    dryRun: boolean
): Promise<void> {
    // Ensure migrations table exists
    await client.query(`
        CREATE TABLE IF NOT EXISTS "${migrationsTable}" (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            run_on TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);

    // Get applied migrations
    const appliedResult = await client.query(
        `SELECT name FROM "${migrationsTable}" ORDER BY run_on ASC`
    );
    const appliedMigrations = new Set(appliedResult.rows.map((r) => r.name));

    // Get migration directories
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const migrationDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => extractNumericPrefix(a) - extractNumericPrefix(b));

    // Find migrations to apply
    const migrationsToApply: { name: string; sql: string }[] = [];
    for (const migrationDir of migrationDirs) {
        if (appliedMigrations.has(migrationDir)) {
            continue;
        }

        const sqlPath = path.join(dir, migrationDir, "migration.sql");
        try {
            const sql = await fs.readFile(sqlPath, "utf-8");
            migrationsToApply.push({ name: migrationDir, sql });
        } catch {
            // Skip directories without migration.sql
        }
    }

    if (migrationsToApply.length === 0) {
        console.log("No migrations to run!");
        return;
    }

    console.log(`> Migrating files:`);
    for (const migration of migrationsToApply) {
        console.log(`> - ${migration.name}`);
    }

    if (dryRun) {
        console.log("Dry run - no migrations applied");
        return;
    }

    // Apply migrations
    for (const migration of migrationsToApply) {
        console.log(`### MIGRATION ${migration.name} (UP) ###`);
        await client.query(migration.sql);
        await client.query(
            `INSERT INTO "${migrationsTable}" (name) VALUES ($1)`,
            [migration.name]
        );
    }
}

export async function runMigrations({
    namespace,
    url,
    dir,
    direction = "up",
    count,
    dryRun = false,
}: MigrationOptions): Promise<void> {
    const migrationsTable = namespace
        ? `hexai__migrations_${namespace}`
        : "hexai__migrations";

    const client = new pg.Client(url);
    try {
        await client.connect();
        await ensureTableCompatibility(client, migrationsTable);

        // Check if this is SQL-based migrations or JavaScript-based
        const isSqlFormat = await isSqlMigrationFormat(dir);

        if (isSqlFormat) {
            // Run SQL-based migrations
            await runSqlMigrations(client, dir, migrationsTable, dryRun);
        } else {
            // Run JavaScript-based migrations using node-pg-migrate
            await client.end();
            await runner({
                databaseUrl: url.toString(),
                dir,
                direction,
                count,
                migrationsTable,
                dryRun,
                singleTransaction: true,
                log: (msg: string) => {
                    // Filter out timestamp warnings for backward compatibility
                    // with migration files using simple numeric prefixes (e.g., 1_initial.js)
                    if (!msg.startsWith("Can't determine timestamp for")) {
                        console.log(msg);
                    }
                },
            });
            return;
        }
    } finally {
        try {
            await client.end();
        } catch {
            // Client already closed
        }
    }
}
