import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import {
    IsolationLevel,
    Propagation,
    UnitOfWorkAbortedError,
} from "Hexai/infra";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";

export class Transaction {
    private static storage = new AsyncLocalStorage<Transaction>();
    private static clientFactory: ClientFactory;
    private static clientCleanUp: ClientCleanUp | undefined;

    public static getCurrentTransaction(): Transaction | undefined {
        return this.storage.getStore();
    }

    public static startNewTransaction<T>(
        fn: (client: pg.Client) => Promise<T>,
        options: Partial<PostgresTransactionOptions>
    ): Promise<T> {
        const transaction = new this(options);
        return this.storage.run(transaction, () => transaction.run(fn));
    }

    private static makeOptions(
        options: Partial<PostgresTransactionOptions> = {}
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.NESTED,
            ...options,
        };
    }

    public static setClientFactory(factory: ClientFactory): void {
        this.clientFactory = factory;
    }

    public static setClientCleanUp(cleanUp?: ClientCleanUp): void {
        this.clientCleanUp = cleanUp;
    }

    private static async spawnNewClient(): Promise<pg.Client> {
        const client = await this.clientFactory();

        if (!(client instanceof pg.Client)) {
            throw new Error("Client factory must return a pg.Client");
        }

        try {
            await client.connect();
        } catch (e) {
            if ((e as Error).message.match(/.*has already been connected.*/i)) {
                // ignore
            } else {
                throw e;
            }
        }

        return client;
    }

    private static async annihilateClient(client: pg.Client): Promise<void> {
        await this.clientCleanUp?.(client);
    }

    private originalClient!: pg.Client;
    private patchedClient!: pg.Client;
    private options!: PostgresTransactionOptions;
    private state:
        | "not started"
        | "starting"
        | "running"
        | "committed"
        | "aborted" = "not started";
    private currentLevel = 0;

    constructor(options: Partial<PostgresTransactionOptions> = {}) {
        this.setOptions(options);
    }

    async start(): Promise<void> {
        if (this.state !== "not started") {
            return;
        }
        this.state = "starting";

        this.originalClient = await Transaction.spawnNewClient();
        this.patchedClient = this.patchClient(this.originalClient);

        await this.begin();
        this.state = "running";
    }

    private patchClient(client: pg.Client): pg.Client {
        const isAborted = () => this.state === "aborted";

        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    if (isAborted()) {
                        throw new UnitOfWorkAbortedError(
                            "This unit of work is aborted"
                        );
                    }

                    return target.query.bind(target);
                }

                return Reflect.get(target, prop, receiver);
            },
        });
    }

    private async begin(): Promise<void> {
        const client = this.getClient();
        await client.query("BEGIN");
        await client.query(
            `SET TRANSACTION ISOLATION LEVEL ${this.getIsolationLevel()}`
        );
    }

    public async run<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
        if (this.state === "not started") {
            await this.start();
        }

        const client = this.getClient();
        try {
            return await this.runInSavepoint(client, fn);
        } finally {
            // root level
            if (this.isRoot()) {
                await Transaction.annihilateClient(this.originalClient);
            }
        }
    }

    private async runInSavepoint<T>(
        client: pg.Client,
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        const useSavepoint = this.getPropagation() === Propagation.NESTED;
        this.currentLevel++;
        const isRootNode = this.isRoot();

        try {
            if (useSavepoint) {
                await client.query(`SAVEPOINT savepoint_${this.currentLevel}`);
            }

            return await fn(client);
        } catch (e) {
            if (useSavepoint) {
                if (!isRootNode) {
                    await client.query(
                        `ROLLBACK TO SAVEPOINT savepoint_${this.currentLevel}`
                    );
                }
            } else {
                this.abort();
            }

            throw e;
        } finally {
            this.currentLevel--;

            if (this.isRoot()) {
                await this.commitOrRollback();
            }
        }
    }

    private isRoot(): boolean {
        return this.currentLevel === 0;
    }

    private async commitOrRollback(): Promise<void> {
        const client = this.originalClient;
        if (this.state === "aborted") {
            await client.query("ROLLBACK");
        } else {
            await client.query("COMMIT");
        }
    }

    public getClient(): pg.Client {
        return this.patchedClient;
    }

    private abort(): void {
        this.state = "aborted";
    }

    private getIsolationLevel(): IsolationLevel {
        return this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
    }

    private getPropagation(): Propagation {
        return this.options.propagation ?? Propagation.NESTED;
    }

    public setOptions(options: Partial<PostgresTransactionOptions>): void {
        this.options = Transaction.makeOptions(options);
    }
}
