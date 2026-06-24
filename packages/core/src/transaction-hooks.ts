import type {
    BeforeCommitPhase,
    TransactionHook,
} from "./unit-of-work.js";

type BeforeCommitCursor = "idle" | "main" | "drain" | "done";

export class BeforeCommitPhaseClosedError extends Error {
    constructor(phase: BeforeCommitPhase, currentPhase: BeforeCommitCursor) {
        super(
            `Cannot register ${phase} beforeCommit hook while ${currentPhase} phase is active`
        );
        this.name = "BeforeCommitPhaseClosedError";
    }
}

export class TransactionHooks {
    private mainBeforeCommitHooks: TransactionHook[] = [];
    private drainBeforeCommitHooks: TransactionHook[] = [];
    private afterCommitHooks: TransactionHook[] = [];
    private afterRollbackHooks: TransactionHook[] = [];
    private beforeCommitCursor: BeforeCommitCursor = "idle";

    addBeforeCommit(
        hook: TransactionHook,
        phase: BeforeCommitPhase = "main"
    ): void {
        this.assertBeforeCommitPhaseOpen(phase);

        if (phase === "drain") {
            this.drainBeforeCommitHooks.push(hook);
            return;
        }

        this.mainBeforeCommitHooks.push(hook);
    }

    addAfterCommit(hook: TransactionHook): void {
        this.afterCommitHooks.push(hook);
    }

    addAfterRollback(hook: TransactionHook): void {
        this.afterRollbackHooks.push(hook);
    }

    async executeCommit(
        commitFn: () => Promise<void>,
        rollbackFn: () => Promise<void>
    ): Promise<void> {
        try {
            this.beforeCommitCursor = "main";
            for (const hook of this.mainBeforeCommitHooks) await hook();

            this.beforeCommitCursor = "drain";
            for (const hook of this.drainBeforeCommitHooks) await hook();

            this.beforeCommitCursor = "done";
        } catch (e) {
            this.beforeCommitCursor = "done";
            await this.executeRollback(rollbackFn, e);
            throw e;
        }

        await commitFn();
        await this.runBestEffort(this.afterCommitHooks);
    }

    async executeRollback(
        rollbackFn: () => Promise<void>,
        cause?: unknown
    ): Promise<void> {
        await rollbackFn();
        await this.runBestEffort(this.afterRollbackHooks, cause);
    }

    private assertBeforeCommitPhaseOpen(phase: BeforeCommitPhase): void {
        if (
            this.beforeCommitCursor === "done" ||
            this.beforeCommitCursor === "drain" ||
            (this.beforeCommitCursor === "main" && phase === "main")
        ) {
            throw new BeforeCommitPhaseClosedError(
                phase,
                this.beforeCommitCursor
            );
        }
    }

    private async runBestEffort(
        hooks: TransactionHook[],
        cause?: unknown
    ): Promise<void> {
        const errors: unknown[] = [];
        for (const hook of hooks) {
            try {
                await hook();
            } catch (e) {
                errors.push(e);
            }
        }
        if (errors.length > 0) {
            throw cause !== undefined
                ? new AggregateError(
                      errors,
                      "Transaction hook(s) failed",
                      { cause }
                  )
                : new AggregateError(errors);
        }
    }
}
