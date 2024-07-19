import { CommonUnitOfWorkOptions, Propagation } from "@hexai/core";

enum TransactionState {
    NOT_STARTED = "not started",
    STARTING = "starting",
    RUNNING = "running",
    ABORT = "abort",
    EXITED = "exited",
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

        this.toStartingState();

        await this.initialize();
        await this.begin();

        this.toRunningState();
    }

    public abstract getClient(): C;

    public async run<T>(
        fn: (client: C) => Promise<T>,
        options: Partial<O>
    ): Promise<T> {
        this.options = this.resolveOptions(options);
        if (this.isNotStarted()) {
            await this.start();
        }

        if (
            !this.isRoot() &&
            this.getPropagationType() === Propagation.NESTED
        ) {
            return await this.runFnInSavepoint(fn);
        } else {
            return await this.runFn(fn);
        }
    }

    protected abstract resolveOptions(options: Partial<O>): O;

    private getPropagationType(): Propagation {
        return this.options.propagation;
    }

    private async runFn<T>(fn: (client: C) => Promise<T>): Promise<T> {
        try {
            return await this.withLevelAdjustment(fn);
        } catch (e) {
            this.toAbortState();
            throw e;
        } finally {
            if (this.isAbort()) {
                await this.rollback();
            } else if (this.isRoot()) {
                await this.commit();
            }
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

    private async exit(): Promise<void> {
        await this.annihilate();
        this.toExitedState();
    }

    protected isRoot(): boolean {
        return this.currentLevel === 0;
    }

    private async runFnInSavepoint<T>(
        fn: (client: C) => Promise<T>
    ): Promise<T> {
        try {
            await this.executeSavepoint();

            return await this.withLevelAdjustment(fn);
        } catch (e) {
            await this.executeRollbackToSavepoint();

            throw e;
        }
    }

    // to override
    protected abstract initialize(): Promise<void>;

    protected async begin(): Promise<void> {
        await this.executeBegin();
        this.toRunningState();
    }

    protected abstract executeBegin(): Promise<void>;

    protected async commit(): Promise<void> {
        if (this.isExited()) {
            return;
        }

        await this.executeCommit();

        await this.exit();
    }

    protected async rollback(): Promise<void> {
        if (this.isExited()) {
            return;
        }

        await this.executeRollback();

        await this.exit();
    }

    protected abstract executeCommit(): Promise<void>;
    protected abstract executeRollback(): Promise<void>;
    protected abstract executeSavepoint(): Promise<void>;
    protected abstract executeRollbackToSavepoint(): Promise<void>;
    protected annihilate(): Promise<void> {
        return Promise.resolve();
    }

    // state mutations & queries
    protected toStartingState(): void {
        this.state = TransactionState.STARTING;
    }

    protected toRunningState(): void {
        this.state = TransactionState.RUNNING;
    }

    protected toAbortState(): void {
        this.state = TransactionState.ABORT;
    }

    protected toExitedState(): void {
        this.state = TransactionState.EXITED;
    }

    protected hasBeenStarted(): boolean {
        return this.state !== TransactionState.NOT_STARTED;
    }

    protected isNotStarted(): boolean {
        return this.state === TransactionState.NOT_STARTED;
    }

    protected isAbort(): boolean {
        return this.state === TransactionState.ABORT;
    }

    protected isExited(): boolean {
        return this.state === TransactionState.EXITED;
    }
}
