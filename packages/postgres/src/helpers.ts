import fs from "node:fs/promises";
import path from "node:path";

import * as pg from "pg";

import { PostgresConfig } from "@/config";

export class ClientWrapper {
    protected client: pg.Client;

    public getClient(): pg.Client {
        return this.client;
    }

    constructor(urlOrClient: PostgresConfig | string | pg.Client) {
        if (
            urlOrClient instanceof PostgresConfig ||
            typeof urlOrClient === "string"
        ) {
            this.client = new pg.Client({
                connectionString: urlOrClient.toString(),
            });
        } else {
            this.client = urlOrClient;
        }
    }

    protected async withClient<T = unknown>(
        work: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        await ensureConnection(this.client);
        return work(this.client);
    }

    public async query<R = any>(
        query: string,
        params?: any[]
    ): Promise<Array<R>> {
        const result = await this.withClient((client) =>
            client.query(query, params)
        );
        return result.rows;
    }

    public async close(): Promise<void> {
        await this.client.end();
    }
}

export class DatabaseManager extends ClientWrapper {
    public async createDatabase(name: string): Promise<void> {
        const exists = await this.query(
            `SELECT 1 FROM pg_database WHERE datname = '${name}'`
        );

        if (exists.length === 0) {
            await this.client.query(`CREATE DATABASE ${name}`);
        }
    }

    public async dropDatabase(name: string): Promise<void> {
        await this.query(`DROP DATABASE IF EXISTS ${name}`);
    }
}

export class MigrationManager extends ClientWrapper {
    public tableManager: TableManager;
    private static readonly MIGRATION_TABLE: [
        string,
        {
            name: string;
            property: string;
        }[],
    ] = [
        "hexai__migrations",
        [
            {
                name: "name",
                property: "VARCHAR(255) NOT NULL",
            },
            {
                name: "applied_at",
                property: "TIMESTAMP NOT NULL DEFAULT NOW()",
            },
        ],
    ];

    private static withNamespace(namespace: string | undefined, name: string) {
        return namespace ? `${namespace}__${name}` : name;
    }

    private static stripNamespace(namespace: string | undefined, name: string) {
        return namespace ? name.replace(`${namespace}__`, "") : name;
    }

    private static hasNamespace(namespace: string | undefined, name: string) {
        return namespace ? name.startsWith(`${namespace}__`) : false;
    }

    constructor(
        urlOrClient: string | pg.Client,
        private namespace?: string
    ) {
        super(urlOrClient);

        this.tableManager = new TableManager(this.client);
    }

    public async open(): Promise<void> {
        await this.ensureMigrationTableCreated();
    }

    public async ensureMigrationTableCreated(): Promise<void> {
        const exists = await this.tableManager.tableExists(
            MigrationManager.MIGRATION_TABLE[0]
        );
        if (exists) {
            return;
        }

        await this.tableManager.createTable(
            ...MigrationManager.MIGRATION_TABLE
        );
    }

    public async getAppliedMigrations(): Promise<string[]> {
        const queryResult = await this.query(
            `SELECT name FROM hexai__migrations ORDER BY applied_at ASC;`
        );

        let migrations = queryResult.map((row) => row.name);

        migrations = this.stripNamespaceFromMigrations(migrations);

        return migrations;
    }

    private stripNamespaceFromMigrations(migrations: string[]): string[] {
        if (!this.namespace) {
            return migrations;
        }

        return migrations
            .filter((name) =>
                MigrationManager.hasNamespace(this.namespace, name)
            )
            .map((name) =>
                MigrationManager.stripNamespace(this.namespace, name)
            );
    }

    public async applyMigrations(
        migrations: Array<{
            name: string;
            sql: string;
        }>
    ): Promise<void> {
        const client = this.getClient();

        await runInsideTransaction(client, async () => {
            for (const migration of migrations) {
                await Promise.all([
                    this.query(migration.sql),
                    this.markMigrationsAsApplied(migration.name),
                ]);
            }
        });
    }

    private async markMigrationsAsApplied(
        ...migrations: string[]
    ): Promise<void> {
        for (const migration of migrations) {
            await this.query(
                `INSERT INTO hexai__migrations (name) VALUES ($1);`,
                [migration]
            );
        }
    }

    public async getMigrationsToApply(dir: string): Promise<
        Array<{
            name: string;
            sql: string;
        }>
    > {
        const migrations = await this.getMigrationsFromFileSystem(dir);
        const appliedMigrations = await this.getAppliedMigrations();

        // check that all applied migrations are in the migrations directory
        for (const appliedMigration of appliedMigrations) {
            if (!migrations.includes(appliedMigration)) {
                throw new Error(
                    `Applied migration ${appliedMigration} not found in migrations directory`
                );
            }
        }

        const prevMaxMigrationIndex = Math.max(
            ...migrations.map((name) => appliedMigrations.indexOf(name))
        );

        const migrationsToApply = migrations.slice(prevMaxMigrationIndex + 1);
        return Promise.all(
            migrationsToApply.map(async (migrationDir) => {
                const migrationPath = path.join(
                    dir,
                    migrationDir,
                    "migration.sql"
                );
                const sql = await fs.readFile(migrationPath, "utf-8");

                return {
                    name: MigrationManager.withNamespace(
                        this.namespace,
                        migrationDir
                    ),
                    sql,
                };
            })
        );
    }

    private async getMigrationsFromFileSystem(dir: string): Promise<string[]> {
        const migrationDirs = (await fs.readdir(dir, { withFileTypes: true }))
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => dirent.name)
            .sort();

        return migrationDirs;
    }
}

export class TableManager extends ClientWrapper {
    public async getTableSchema(tableName: string): Promise<
        Array<{
            column: string;
            type: string;
        }>
    > {
        const result = await this.query(`
            SELECT
                column_name AS column,
                data_type AS type
            FROM information_schema.columns
            WHERE table_name = '${tableName}';
        `);

        return result.map((row) => ({
            column: row.column,
            type: row.type,
        }));
    }

    public async tableExists(tableName: string): Promise<boolean> {
        const result = await this.query(`
            SELECT
                table_name
            FROM information_schema.tables
            WHERE table_name = '${tableName}';
        `);

        return result.length > 0;
    }

    public async createTable(
        name: string,
        columns: Array<{
            name: string;
            property: string;
        }>
    ): Promise<void> {
        if (await this.tableExists(name)) {
            return;
        }

        const query = `
            CREATE TABLE ${name} (
                ${columns
                    .map((column) => `${column.name} ${column.property}`)
                    .join(", ")}
            );
        `;

        await this.query(query);
    }

    public async dropTable(name: string): Promise<void> {
        await this.query(`DROP TABLE IF EXISTS "${name}";`);
    }

    public async truncateTable(name: string): Promise<void> {
        await this.query(`TRUNCATE TABLE "${name}" RESTART IDENTITY CASCADE;`);
    }

    public async truncateAllTables(): Promise<void> {
        const tables = await this.getTableNames();

        await Promise.all(tables.map((table) => this.truncateTable(table)));
    }

    public async dropAllTables(): Promise<void> {
        const tables = await this.getTableNames();

        await Promise.all(tables.map((table) => this.dropTable(table)));
    }

    private async getTableNames(): Promise<string[]> {
        const result = await this.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE';
        `);

        return result.map((row) => row.table_name);
    }
}

export async function runInsideTransaction<T = unknown>(
    client: pg.Client,
    fn: (client: pg.Client) => Promise<T>
): Promise<T> {
    await client.query("BEGIN");

    try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
}

export async function ensureConnection(client: pg.ClientBase): Promise<void> {
    try {
        await client.connect();
    } catch (e) {
        if ((e as Error).message.includes("already")) {
            // ignore
        } else {
            throw e;
        }
    }
}

export function isDatabaseError(e: any): e is pg.DatabaseError {
    return e instanceof Error && "code" in e;
}
