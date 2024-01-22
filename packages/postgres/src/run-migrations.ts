import fs from "node:fs/promises";
import path from "node:path";
import { MigrationManager } from "./helpers";

export async function runMigrations({
    namespace,
    url,
    dir,
}: {
    namespace: string;
    url: string;
    dir: string;
}): Promise<void> {
    const migrationManager = new MigrationManager(url);

    try {
        await migrationManager.ensureMigrationTableCreated();
        const appliedMigrations = await migrationManager.getAppliedMigrations();
        const migrationsToApply = (
            await getMigrationsToApply(dir, appliedMigrations)
        ).map((m) => ({
            ...m,
            name: namespace ? `${namespace}__${m.name}` : m.name,
        }));

        console.log(
            `migrations to apply: ${migrationsToApply
                .map((m) => m.name)
                .join(", ")}`
        );

        await migrationManager.applyMigrations(migrationsToApply);
    } finally {
        await migrationManager.close();
    }
}

async function getMigrationsToApply(
    dir: string,
    appliedMigrations: string[]
): Promise<
    Array<{
        name: string;
        sql: string;
    }>
> {
    const migrationInFileSystem = await getMigrationsFromFileSystem(dir);

    const appliedMigrationSet = new Set(appliedMigrations);
    const firstNotAppliedMigrationIndex = migrationInFileSystem.findIndex(
        (migrationDir) => !appliedMigrationSet.has(migrationDir)
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
