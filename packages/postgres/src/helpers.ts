import * as pg from "pg";

import { replaceDatabaseNameIn } from "@hexai/core/utils";
import { DB_URL } from "@/config";

export class ClientWrapper {
    protected client: pg.Client;

    public getClient(): pg.Client {
        return this.client;
    }

    constructor(urlOrClient: string | pg.Client) {
        if (typeof urlOrClient === "string") {
            this.client = new pg.Client({
                connectionString: urlOrClient,
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

    constructor(urlOrClient: string | pg.Client) {
        super(urlOrClient);

        this.tableManager = new TableManager(this.client);
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
        const result = await this.query(
            `SELECT name FROM hexai__migrations ORDER BY applied_at ASC;`
        );

        return result.map((row) => row.name);
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
        await this.query(`DROP TABLE IF EXISTS ${name};`);
    }

    public async truncateTable(name: string): Promise<void> {
        await this.query(`TRUNCATE TABLE ${name} RESTART IDENTITY CASCADE;`);
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

export function replaceDatabaseName(database: string, url?: string): string {
    return replaceDatabaseNameIn(url || DB_URL, database);
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

export async function ensureConnection(client: pg.Client): Promise<void> {
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
