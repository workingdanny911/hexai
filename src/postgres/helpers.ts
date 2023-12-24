import { DB_URL } from "Hexai/config";
import * as pg from "pg";

export function getDatabaseName(url?: string): string {
    return (url || DB_URL).match(/([\w_])+$/)![0];
}

export function replaceDatabaseName(database: string, url?: string): string {
    return (url || DB_URL).replace(/([\w_])+$/, database);
}

export async function createClient(url?: string): Promise<pg.Client> {
    const client = new pg.Client({
        connectionString: url || DB_URL,
    });
    await client.connect();
    return client;
}

export async function createPrivilegedClient(url?: string): Promise<pg.Client> {
    const client = new pg.Client({
        connectionString: replaceDatabaseName("postgres", url),
    });
    await client.connect();
    return client;
}

export async function createDatabase(
    name?: string,
    client?: pg.Client
): Promise<void> {
    await withClient(async (client) => {
        const exists = await client.query(
            `SELECT 1 FROM pg_database WHERE datname = '${
                name || getDatabaseName()
            }'`
        );

        if (exists.rows.length === 0) {
            await client.query(`CREATE DATABASE ${name || getDatabaseName()}`);
        }
    }, client ?? createPrivilegedClient);
}

export async function dropDatabase(
    name?: string,
    client?: pg.Client
): Promise<void> {
    await withClient(async (client) => {
        await client.query(
            `DROP DATABASE IF EXISTS ${name || getDatabaseName()}`
        );
    }, client ?? createPrivilegedClient);
}

async function withClient<T = unknown>(
    work: (client: pg.Client) => Promise<T>,
    clientOrFactory: pg.Client | (() => Promise<pg.Client>)
): Promise<T> {
    let isLocallyCreated = false;
    let client: pg.Client;

    if (typeof clientOrFactory === "function") {
        client = await clientOrFactory();
        isLocallyCreated = true;
    } else {
        client = clientOrFactory;
    }

    try {
        return await work(client);
    } finally {
        if (isLocallyCreated) {
            await client.end();
        }
    }
}

export async function createMigrationsTable(client?: pg.Client): Promise<void> {
    await withClient(async (client) => {
        const queryExists = await client.query(`
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'hexai__migrations';
    `);

        if (queryExists.rows.length > 0) {
            return;
        }

        await client.query(`
        CREATE TABLE hexai__migrations (
            name VARCHAR(255) NOT NULL,
            applied_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);
    }, client ?? createClient);
}

export async function getAppliedMigrations(
    client?: pg.Client
): Promise<string[]> {
    return withClient(async (client) => {
        const result = await client.query(
            `SELECT name FROM hexai__migrations ORDER BY applied_at ASC;`
        );
        return result.rows.map((row) => row.name);
    }, client ?? createClient);
}

export async function deleteMigrationsTable(client?: pg.Client): Promise<void> {
    await withClient(async (client) => {
        await client.query(`DROP TABLE IF EXISTS hexai__migrations;`);
    }, client ?? createClient);
}
