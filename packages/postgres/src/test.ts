import { AsyncLocalStorage } from "node:async_hooks";
import { Client, ClientBase } from "pg";

import { Propagation } from "@hexaijs/core";
import { DatabaseManager, isDatabaseError, TableManager } from "@/helpers";
import { PostgresConfig } from "@/config";
import { runHexaiMigrations } from "@/run-hexai-migrations";
import { PostgresTransactionOptions } from "@/types";
import { PostgresUnitOfWork } from "./postgres-unit-of-work";

export function createTestContext(dbUrl: string | PostgresConfig) {
    const config =
        typeof dbUrl === "string" ? PostgresConfig.fromUrl(dbUrl) : dbUrl;

    const dbName = config.database;
    const databaseManager = new DatabaseManager(
        config.withDatabase("postgres")
    );
    const tableManager = new TableManager(config);

    async function setup(): Promise<void> {
        try {
            await databaseManager.dropDatabase(dbName);
        } catch (e) {
            if (isDatabaseError(e) && e.code === "3D000") {
                // ignore
            } else {
                throw e;
            }
        }

        await databaseManager.createDatabase(dbName);
        await runHexaiMigrations(config);
    }

    async function teardown(): Promise<void> {
        await tableManager.close();
        await databaseManager.dropDatabase(dbName);
        await databaseManager.close();
    }

    return {
        client: tableManager.getClient(),
        newClient: () => new Client(dbUrl),
        tableManager,
        setup,
        teardown,
    };
}

export class PostgresUnitOfWorkForTesting implements PostgresUnitOfWork {
    private executorStorage = new AsyncLocalStorage<TestTransactionExecutor>();

    constructor(private client: ClientBase) {}

    public getClient(): ClientBase {
        const executor = this.getCurrentExecutor();
        if (!executor) {
            throw new Error("Unit of work not started");
        }
        return this.client;
    }

    async withClient<T>(fn: (client: ClientBase) => Promise<T>): Promise<T> {
        return fn(this.client);
    }

    async scope<T = unknown>(
        fn: () => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        return this.wrap(fn, options);
    }

    async wrap<T = unknown>(
        fn: (client: ClientBase) => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);
        const executor = this.resolveExecutor(resolvedOptions);

        return this.executeInContext(executor, (exec) =>
            exec.execute(fn, resolvedOptions)
        );
    }

    private getCurrentExecutor(): TestTransactionExecutor | null {
        return this.executorStorage.getStore() ?? null;
    }

    private resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    private resolveExecutor(
        options: PostgresTransactionOptions
    ): TestTransactionExecutor {
        if (options.propagation === Propagation.NEW) {
            console.warn(
                "[PostgresUnitOfWorkForTesting] Propagation.NEW is not fully supported in testing mode. Using savepoint instead."
            );
            return this.createExecutor();
        }
        return this.getCurrentExecutor() ?? this.createExecutor();
    }

    private createExecutor(): TestTransactionExecutor {
        return new TestTransactionExecutor(this.client);
    }

    private executeInContext<T>(
        executor: TestTransactionExecutor,
        callback: (executor: TestTransactionExecutor) => Promise<T>
    ): Promise<T> {
        return this.executorStorage.run(executor, () => callback(executor));
    }
}

class TestTransactionExecutor {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;
    private savepointCounter = 0;
    private savepoints: TestSavepoint[] = [];
    private savepointName: string;

    constructor(private readonly client: ClientBase) {
        this.savepointName = `test_sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    public async execute<T>(
        fn: (client: ClientBase) => Promise<T>,
        options: PostgresTransactionOptions
    ): Promise<T> {
        await this.ensureStarted();

        const executor = this.resolveExecutor(options.propagation);
        return executor === this
            ? this.runWithLifecycle(fn)
            : executor.execute(fn, options);
    }

    public getClient(): ClientBase {
        return this.client;
    }

    private async ensureStarted(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.initialized = true;
        await this.client.query(`SAVEPOINT ${this.savepointName}`);
    }

    private async runWithLifecycle<T>(
        fn: (client: ClientBase) => Promise<T>
    ): Promise<T> {
        try {
            return await this.executeWithNesting(fn);
        } catch (e) {
            this.markAsAborted(e as Error);
            throw e;
        } finally {
            await this.finalizeIfRoot();
        }
    }

    private async executeWithNesting<T>(
        fn: (client: ClientBase) => Promise<T>
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
    ): TestTransactionExecutor | TestSavepoint {
        if (this.nestingDepth === 0) {
            return this;
        }

        return propagation === Propagation.NESTED
            ? this.createSavepoint()
            : (this.findActiveSavepoint() ?? this);
    }

    private createSavepoint(): TestSavepoint {
        this.savepointCounter++;
        const savepoint = new TestSavepoint(
            `${this.savepointName}_nested_${this.savepointCounter}`,
            this.client,
            () => this.removeSavepoint()
        );
        this.savepoints.push(savepoint);
        return savepoint;
    }

    private findActiveSavepoint(): TestSavepoint | undefined {
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
        await this.client.query(`RELEASE SAVEPOINT ${this.savepointName}`);
    }

    private async rollback(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.client.query(
            `ROLLBACK TO SAVEPOINT ${this.savepointName}`
        );
    }

    private isAborted(): boolean {
        return this.abortError !== undefined && !this.closed;
    }
}

class TestSavepoint {
    private initialized = false;
    private closed = false;
    private abortError?: Error;

    private nestingDepth = 0;

    constructor(
        private readonly name: string,
        private readonly client: ClientBase,
        private readonly onClose: () => void
    ) {}

    public async execute<T>(
        fn: (client: ClientBase) => Promise<T>
    ): Promise<T> {
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
        fn: (client: ClientBase) => Promise<T>
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
