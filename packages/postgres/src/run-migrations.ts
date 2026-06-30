import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as pg from "pg";
import { runner } from "node-pg-migrate";

import { PostgresConfig } from "./config/index.js";

const MIGRATION_LOCK_CLASS_ID = 0x68657861;

type SqlMigration = {
    name: string;
    sql: string;
};

class DuplicateMigrationRecordError extends Error {
    constructor(tableName: string, duplicateNames: string[]) {
        super(
            `Duplicate migration records found in ${tableName}: ${duplicateNames.join(
                ", "
            )}`
        );
        this.name = "DuplicateMigrationRecordError";
    }
}

class MigrationFailedError extends Error {
    constructor(tableName: string, migrationName: string, cause: unknown) {
        const causeMessage =
            cause instanceof Error ? cause.message : String(cause);
        super(
            `Migration ${migrationName} failed for ${tableName}: ${causeMessage}`
        );
        this.name = "MigrationFailedError";
        (this as Error & { cause?: unknown }).cause = cause;
    }
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replaceAll('"', '""')}"`;
}

function migrationNameIndexName(tableName: string): string {
    const prefix = tableName.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 40);
    const hash = createHash("sha1").update(tableName).digest("hex").slice(0, 12);
    return `${prefix}_${hash}_name_idx`;
}

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
    const quotedTableName = quoteIdentifier(tableName);
    if (!(await migrationsTableExists(client, tableName))) return;

    const hasAppliedAt = await client.query(
        `
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = 'applied_at'
    `,
        [tableName]
    );

    if (hasAppliedAt.rows.length > 0) {
        await client.query(`
            ALTER TABLE ${quotedTableName}
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

async function withMigrationLock<T>(
    client: pg.Client,
    migrationsTable: string,
    work: () => Promise<T>
): Promise<T> {
    await client.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [
        MIGRATION_LOCK_CLASS_ID,
        migrationsTable,
    ]);

    try {
        return await work();
    } finally {
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
            MIGRATION_LOCK_CLASS_ID,
            migrationsTable,
        ]);
    }
}

async function migrationsTableExists(
    client: pg.Client,
    migrationsTable: string
): Promise<boolean> {
    const result = await client.query(
        `
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = current_schema()
            AND table_name = $1
        `,
        [migrationsTable]
    );

    return result.rows.length > 0;
}

async function ensureMigrationsTable(
    client: pg.Client,
    migrationsTable: string
): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${quoteIdentifier(migrationsTable)} (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            run_on TIMESTAMP NOT NULL DEFAULT NOW()
        )
    `);
}

async function assertNoDuplicateMigrationRecords(
    client: pg.Client,
    migrationsTable: string
): Promise<void> {
    const result = await client.query(
        `
            SELECT name
            FROM ${quoteIdentifier(migrationsTable)}
            GROUP BY name
            HAVING COUNT(*) > 1
            ORDER BY name ASC
        `
    );

    if (result.rows.length > 0) {
        throw new DuplicateMigrationRecordError(
            migrationsTable,
            result.rows.map((row) => row.name)
        );
    }
}

async function hasUniqueMigrationNameIndex(
    client: pg.Client,
    migrationsTable: string
): Promise<boolean> {
    const result = await client.query(
        `
            SELECT 1
            FROM pg_indexes
            WHERE schemaname = current_schema()
            AND tablename = $1
            AND indexdef LIKE '%UNIQUE%'
            AND indexdef LIKE '%(name)%'
            LIMIT 1
        `,
        [migrationsTable]
    );

    return result.rows.length > 0;
}

async function ensureMigrationNameUniqueIndex(
    client: pg.Client,
    migrationsTable: string
): Promise<void> {
    if (await hasUniqueMigrationNameIndex(client, migrationsTable)) {
        return;
    }

    await client.query(`
        CREATE UNIQUE INDEX ${quoteIdentifier(
            migrationNameIndexName(migrationsTable)
        )}
        ON ${quoteIdentifier(migrationsTable)} (name)
    `);
}

async function readAppliedMigrations(
    client: pg.Client,
    migrationsTable: string
): Promise<Set<string>> {
    const appliedResult = await client.query(
        `SELECT name FROM ${quoteIdentifier(migrationsTable)} ORDER BY id ASC`
    );

    return new Set(appliedResult.rows.map((row) => row.name));
}

async function readAppliedMigrationsIfTableExists(
    client: pg.Client,
    migrationsTable: string
): Promise<Set<string>> {
    if (!(await migrationsTableExists(client, migrationsTable))) {
        return new Set();
    }

    return readAppliedMigrations(client, migrationsTable);
}

async function discoverSqlMigrationsToApply(
    dir: string,
    appliedMigrations: Set<string>
): Promise<SqlMigration[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const migrationDirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => extractNumericPrefix(a) - extractNumericPrefix(b));

    const migrationsToApply: SqlMigration[] = [];
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

    return migrationsToApply;
}

function logMigrationsToApply(migrationsToApply: SqlMigration[]): void {
    console.log(`> Migrating files:`);
    for (const migration of migrationsToApply) {
        console.log(`> - ${migration.name}`);
    }
}

async function applySqlMigrationAtomically(
    client: pg.Client,
    migrationsTable: string,
    migration: SqlMigration
): Promise<void> {
    await client.query("BEGIN");

    try {
        await client.query(migration.sql);
        await client.query(
            `INSERT INTO ${quoteIdentifier(migrationsTable)} (name) VALUES ($1)`,
            [migration.name]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw new MigrationFailedError(migrationsTable, migration.name, error);
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
    await withMigrationLock(client, migrationsTable, async () => {
        if (dryRun) {
            const appliedMigrations = await readAppliedMigrationsIfTableExists(
                client,
                migrationsTable
            );
            const migrationsToApply = await discoverSqlMigrationsToApply(
                dir,
                appliedMigrations
            );

            if (migrationsToApply.length === 0) {
                console.log("No migrations to run!");
                return;
            }

            logMigrationsToApply(migrationsToApply);
            console.log("Dry run - no migrations applied");
            return;
        }

        await ensureTableCompatibility(client, migrationsTable);
        await ensureMigrationsTable(client, migrationsTable);
        await assertNoDuplicateMigrationRecords(client, migrationsTable);
        await ensureMigrationNameUniqueIndex(client, migrationsTable);

        const appliedMigrations = await readAppliedMigrations(
            client,
            migrationsTable
        );
        const migrationsToApply = await discoverSqlMigrationsToApply(
            dir,
            appliedMigrations
        );

        if (migrationsToApply.length === 0) {
            console.log("No migrations to run!");
            return;
        }

        logMigrationsToApply(migrationsToApply);

        for (const migration of migrationsToApply) {
            console.log(`### MIGRATION ${migration.name} (UP) ###`);
            await applySqlMigrationAtomically(
                client,
                migrationsTable,
                migration
            );
        }
    });
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

        // Check if this is SQL-based migrations or JavaScript-based
        const isSqlFormat = await isSqlMigrationFormat(dir);

        if (isSqlFormat) {
            // Run SQL-based migrations
            await runSqlMigrations(client, dir, migrationsTable, dryRun);
        } else {
            // Run JavaScript-based migrations using node-pg-migrate
            await ensureTableCompatibility(client, migrationsTable);
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
