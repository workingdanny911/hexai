import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";

import { Propagation, UnitOfWork } from "@hexaijs/core";
import { IsolationLevel } from "./types";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { ensureConnection } from "./helpers";

export class PostgresUnitOfWork implements UnitOfWork<
    pg.Client,
    PostgresTransactionOptions
> {
    private transactionStorage = new AsyncLocalStorage<PostgresTransaction>();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

    public getClient(): pg.Client {
        const current = this.getCurrentTransaction();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    async wrap<T = unknown>(
        fn: (client: pg.Client) => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);
        const transaction = this.resolveTransaction(resolvedOptions);

        return this.executeInContext(transaction, (tx) =>
            tx.execute(fn, resolvedOptions)
        );
    }

    private getCurrentTransaction(): PostgresTransaction | null {
        return this.transactionStorage.getStore() ?? null;
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    private resolveTransaction(
        options: PostgresTransactionOptions
    ): PostgresTransaction {
        if (options.propagation === Propagation.NEW) {
            return this.createTransaction();
        }
        return this.getCurrentTransaction() ?? this.createTransaction();
    }

    private createTransaction(): PostgresTransaction {
        return new PostgresTransaction(this.clientFactory, this.clientCleanUp);
    }

    private executeInContext<T>(
        transaction: PostgresTransaction,
        callback: (transaction: PostgresTransaction) => Promise<T>
    ): Promise<T> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}

class PostgresTransaction {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;
    private options!: PostgresTransactionOptions;

    private client!: pg.Client;
    private savepoints: Savepoint[] = [];

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

    public async execute<T>(
        fn: (client: pg.Client) => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        this.options = options;
        await this.ensureStarted();

        const executor = this.resolveExecutor(options.propagation);
        return executor === this
            ? this.runWithLifecycle(fn)
            : executor.execute(fn, options);
    }

    public getClient(): pg.Client {
        return this.client;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.initializeClient();
        await this.beginTransaction();
    }

    private async initializeClient(): Promise<void> {
        const client = await this.clientFactory();

        if (!("query" in client)) {
            throw new Error("Client factory must return a pg.Client");
        }

        await ensureConnection(client);
        this.client = client;
    }

    private async beginTransaction(): Promise<void> {
        await this.client.query("BEGIN");

        const isolationLevel =
            this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
        if (isolationLevel !== IsolationLevel.READ_COMMITTED) {
            await this.client.query(
                `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`
            );
        }
    }

    private async runWithLifecycle<T>(
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        try {
            return await this.executeWithNesting(fn);
        } catch (e) {
            console.error(`Transaction aborting, error in transaction:`);
            console.error(e);
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            await this.finalizeIfRoot();
        }
    }

    private async executeWithNesting<T>(
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        this.nestingDepth++;
        try {
            return await fn(this.client);
        } finally {
            this.nestingDepth--;
        }
    }

    private markAsAborted(error: Error): void {
        this.abortError = error;
    }

    private async finalizeIfRoot(): Promise<void> {
        if (this.nestingDepth === 0) {
            await (this.isAborted() ? this.rollback() : this.commit());
        }
    }

    private resolveExecutor(
        propagation: Propagation
    ): PostgresTransaction | Savepoint {
        if (this.nestingDepth === 0) {
            return this;
        }

        return propagation === Propagation.NESTED
            ? this.createSavepoint()
            : (this.findActiveSavepoint() ?? this);
    }

    private createSavepoint(): Savepoint {
        const savepoint = new Savepoint(
            `sp_${this.savepoints.length + 1}`,
            this.client,
            () => this.removeSavepoint()
        );
        this.savepoints.push(savepoint);
        return savepoint;
    }

    private findActiveSavepoint(): Savepoint | undefined {
        for (let i = this.savepoints.length - 1; i >= 0; i--) {
            if (!this.savepoints[i].isClosed()) {
                return this.savepoints[i];
            }
        }
    }

    private removeSavepoint(): void {
        this.savepoints.pop();
    }

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query("COMMIT");
        await this.clientCleanUp?.(this.client);
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;

        try {
            await this.client.query("ROLLBACK");
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.includes("Client was closed and is not queryable")
            ) {
                return;
            }
            throw e;
        }

        await this.clientCleanUp?.(this.client);
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}

class Savepoint {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;

    constructor(
        private readonly name: string,
        private readonly client: pg.Client,
        private readonly onClose: () => void
    ) {}

    public async execute<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
        await this.ensureStarted();
        return this.runWithLifecycle(fn);
    }

    public isClosed(): boolean {
        return this.closed;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.client.query(`SAVEPOINT ${this.name}`);
    }

    private async runWithLifecycle<T>(
        fn: (client: pg.Client) => Promise<T>
    ): Promise<T> {
        this.nestingDepth++;
        try {
            return await fn(this.client);
        } catch (e) {
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            this.nestingDepth--;
            await this.finalizeIfRoot();
        }
    }

    private markAsAborted(error: Error): void {
        this.abortError = error;
    }

    private async finalizeIfRoot(): Promise<void> {
        if (this.nestingDepth === 0) {
            await (this.isAborted() ? this.rollback() : this.commit());
        }
    }

    private async commit(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(`RELEASE SAVEPOINT ${this.name}`);
        this.onClose();
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(`ROLLBACK TO SAVEPOINT ${this.name}`);
        this.onClose();
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}
