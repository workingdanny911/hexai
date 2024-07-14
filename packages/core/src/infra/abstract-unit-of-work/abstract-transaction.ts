import { CommonUnitOfWorkOptions, Propagation } from "@hexai/core";

enum TransactionState {
    NOT_STARTED = "not started",
    STARTING = "starting",
    RUNNING = "running",
    COMMITTED = "committed",
    ABORTED = "aborted",
}

export abstract class AbstractTransaction<
    C,
    O extends CommonUnitOfWorkOptions = CommonUnitOfWorkOptions,
> {
    protected state: TransactionState = TransactionState.NOT_STARTED;
    protected currentLevel = 0;
    protected options!: O;

    // templates
    public async start(): Promise<void> {
        if (this.hasBeenStarted()) {
            return;
        }

        this.starting();

        await this.spawnNewClient();
        await this.begin();

        this.running();
    }

    public abstract getClient(): C;

    public async run<T>(fn: (client: C) => Promise<T>, options: O): Promise<T> {
        this.options = options;

        if (this.isNotStarted()) {
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

    protected getPropagation(): Propagation {
        return this.options.propagation ?? Propagation.NESTED;
    }

    protected isRoot(): boolean {
        return this.currentLevel === 0;
    }

    private async runInSavepoint<T>(fn: (client: C) => Promise<T>): Promise<T> {
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

    private async runFn<T>(fn: (client: C) => Promise<T>): Promise<T> {
        try {
            return await this.withLevelAdjustment(fn);
        } catch (e) {
            this.abort();
            throw e;
        }
    }

    private async withLevelAdjustment<T>(
        fn: (client: C) => Promise<T>
    ): Promise<T> {
        this.currentLevel++;
        try {
            return await fn(this.getClient());
        } finally {
            this.currentLevel--;
        }
    }

    private async commitOrRollback(): Promise<void> {
        if (this.isAborted()) {
            await this.rollback();
        } else {
            await this.commit();
        }
    }

    // to override
    protected abstract spawnNewClient(): Promise<void>;
    protected abstract begin(): Promise<void>;
    protected abstract commit(): Promise<void>;
    protected abstract rollback(): Promise<void>;
    protected abstract enterSavepoint(level: number): Promise<void>;
    protected abstract rollbackToSavepoint(level: number): Promise<void>;
    protected annihilate(): Promise<void> {
        return Promise.resolve();
    }

    // state mutations & queries
    protected starting(): void {
        this.state = TransactionState.STARTING;
    }

    protected running(): void {
        this.state = TransactionState.RUNNING;
    }

    protected abort(): void {
        this.state = TransactionState.ABORTED;
    }

    protected hasBeenStarted(): boolean {
        return this.state !== TransactionState.NOT_STARTED;
    }

    protected isNotStarted(): boolean {
        return this.state === TransactionState.NOT_STARTED;
    }

    protected isAborted(): boolean {
        return this.state === TransactionState.ABORTED;
    }
}
