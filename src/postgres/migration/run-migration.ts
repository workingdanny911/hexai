import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

import { DB_URL } from "Hexai/config";
import { createMigrationsTable, getAppliedMigrations } from "../helpers";

const MIGRATIONS_TABLE = "hexai__migrations";

export async function runMigration(dir: string, url?: string): Promise<void> {
    const client = new Client({ connectionString: url || DB_URL });
    await client.connect();

    try {
        await createMigrationsTable(client);
        const migrationsToApply = await getMigrationsToApply(client, dir);

        console.log(
            `migrations to apply: ${migrationsToApply
                .map((m) => m.name)
                .join(", ")}`
        );

        await runInsideTransaction(client, async () => {
            for (const migration of migrationsToApply) {
                console.log(`applying migration: ${migration.name}`);
                await applyMigration(client, migration);
            }
        });
    } finally {
        await client.end();
    }
}

async function getMigrationsToApply(
    client: Client,
    dir: string
): Promise<
    Array<{
        name: string;
        sql: string;
    }>
> {
    const migrationInFileSystem = await getMigrationsFromFileSystem(dir);

    const appliedMigrations = new Set(await getAppliedMigrations(client));
    const firstNotAppliedMigrationIndex = migrationInFileSystem.findIndex(
        (migrationDir) => !appliedMigrations.has(migrationDir)
    );

    const migrationsToApply = migrationInFileSystem.slice(
        firstNotAppliedMigrationIndex
    );

    return await Promise.all(
        migrationsToApply.map(async (migrationDir) => {
            const migrationPath = path.join(dir, migrationDir, "migration.sql");
            const sql = await fs.readFile(migrationPath, "utf-8");

            return {
                name: migrationDir,
                sql,
            };
        })
    );
}

async function getMigrationsFromFileSystem(dir: string): Promise<string[]> {
    const migrationDirs = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)
        .sort();

    if (migrationDirs.length === 0) {
        throw new Error(`no migration files found in ${dir}`);
    }

    return migrationDirs;
}

async function runInsideTransaction(
    client: Client,
    fn: () => Promise<void>
): Promise<void> {
    await client.query("BEGIN");
    try {
        await fn();
        await client.query("COMMIT");
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
}

async function applyMigration(
    client: Client,
    migration: {
        name: string;
        sql: string;
    }
): Promise<void> {
    await client.query(migration.sql);
    await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ($1);`, [
        migration.name,
    ]);
}
