import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import {
    IsolationLevel,
    Propagation,
    UnitOfWorkAbortedError,
} from "@hexai/core/infra";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { ensureConnection } from "./helpers";

export class Transaction {
    private static storage = new AsyncLocalStorage<Transaction>();
    private static clientFactory: ClientFactory;
    private static clientCleanUp?: ClientCleanUp;

    public static getCurrent(): Transaction | undefined {
        return this.storage.getStore();
    }

    public static startNew<T>(
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

    public static setClientCleanUp(cleanUp: ClientCleanUp): void {
        this.clientCleanUp = cleanUp;
    }

    private static async spawnNewClient(): Promise<pg.Client> {
        const client = await Transaction.clientFactory();

        if (!(client instanceof pg.Client)) {
            throw new Error("Client factory must return a pg.Client");
        }

        await ensureConnection(client);

        return client;
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
    private namespace = "default";

    constructor(options: Partial<PostgresTransactionOptions> = {}) {
        this.setOptions(options);
    }

    public async start(): Promise<void> {
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

        if (this.getIsolationLevel() !== IsolationLevel.READ_COMMITTED) {
            await client.query(
                `SET TRANSACTION ISOLATION LEVEL ${this.getIsolationLevel()}`
            );
        }
    }

    public async run<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
        if (this.state === "not started") {
            await this.start();
        }

        const runner =
            this.getPropagation() === Propagation.NESTED
                ? this.runInSavepoint
                : this.runFn;

        try {
            return (await runner.call(this, fn)) as T;
        } finally {
            if (this.isRoot()) {
                await this.commitOrRollback();
                await this.annihilate();
            }
        }
    }

    private async runInSavepoint<T>(
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        try {
            await this.enterSavepoint(this.currentLevel);

            return await this.withLevelAdjustment(fn);
        } catch (e) {
            if (this.isRoot()) {
                this.abort();
            } else {
                await this.rollbackToSavepoint(this.currentLevel);
            }

            throw e;
        }
    }

    private async withLevelAdjustment<T>(
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        this.currentLevel++;
        try {
            return await fn(this.getClient());
        } finally {
            this.currentLevel--;
        }
    }

    private async runFn<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
        try {
            return await this.withLevelAdjustment(fn);
        } catch (e) {
            this.abort();
            throw e;
        }
    }

    private async enterSavepoint(level: number): Promise<void> {
        await this.getClient().query(`SAVEPOINT savepoint_${level}`);
    }

    private async rollbackToSavepoint(level: number): Promise<void> {
        await this.getClient().query(
            `ROLLBACK TO SAVEPOINT savepoint_${level}`
        );
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

    private async annihilate(): Promise<void> {
        await Transaction.clientCleanUp?.(this.originalClient);
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
