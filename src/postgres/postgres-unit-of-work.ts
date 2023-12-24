import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { UnitOfWork } from "Hexai/infra";

const transactionStore = new AsyncLocalStorage<{
    client: pg.Client;
    options?: PostgresTransactionOptions;
}>();

export enum POSTGRES_ISOLATION {
    READ_COMMITTED = "read committed",
    REPEATABLE_READ = "repeatable read",
    SERIALIZABLE = "serializable",
}

interface PostgresTransactionOptions {
    isolationLevel?: POSTGRES_ISOLATION;
}

type ClientFactory = () => pg.Client | Promise<pg.Client>;

type ClientCleanUp = (client: pg.Client) => void | Promise<void>;

let clientFactory: ClientFactory;

let clientCleanUp: ClientCleanUp | undefined;

function bind(factory: ClientFactory, cleanUp?: ClientCleanUp) {
    clientFactory = factory;
    clientCleanUp = cleanUp;
}

function getClient(): pg.Client {
    const store = transactionStore.getStore();

    if (!store) {
        throw new Error("Unit of work not started");
    }

    return store.client;
}

async function wrap<T = unknown>(
    fn: (client: pg.Client) => Promise<T>,
    options?: PostgresTransactionOptions
): Promise<T> {
    const store = transactionStore.getStore();
    if (!store) {
        return wrapWithNew(fn, options);
    }

    return await execute(store.client, fn);
}

async function wrapWithNew<T = unknown>(
    fn: (client: pg.Client) => Promise<T>,
    options?: PostgresTransactionOptions
): Promise<T> {
    const client = await spawnNewClient();
    await beginTransaction(client, options);

    const store = {
        client,
        options,
    };

    return transactionStore.run(store, () => executeAndCleanUp(client, fn));
}

async function spawnNewClient(): Promise<pg.Client> {
    if (!clientFactory) {
        throw new Error("Client factory should be set before using UoW");
    }

    const client = await clientFactory();
    try {
        await client.connect();
    } catch (e) {
        if ((e as Error).message.search("already been connected") !== -1) {
            // ignore
        } else {
            throw e;
        }
    }

    return client;
}

async function beginTransaction(
    client: pg.Client,
    options?: PostgresTransactionOptions
) {
    await client.query("BEGIN");

    if (options?.isolationLevel) {
        await client.query(
            `SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel}`
        );
    }
}

async function execute<T>(
    client: pg.Client,
    fn: (client: pg.Client) => Promise<T>
): Promise<T> {
    try {
        return await fn(client);
    } catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
}

async function executeAndCleanUp<T>(
    client: pg.Client,
    fn: (client: pg.Client) => Promise<T>
): Promise<T> {
    try {
        const result = await execute(client, fn);
        await client.query("COMMIT");
        return result;
    } finally {
        await clientCleanUp?.(client);
    }
}

export const postgresUnitOfWork: UnitOfWork<
    pg.Client,
    PostgresTransactionOptions
> & {
    bind: typeof bind;
} = {
    wrap,
    wrapWithNew,
    getClient,
    bind,
};
