import type { TransactionHook } from "./unit-of-work";

export class TransactionHooks {
    private beforeCommitHooks: TransactionHook[] = [];
    private afterCommitHooks: TransactionHook[] = [];
    private afterRollbackHooks: TransactionHook[] = [];

    addBeforeCommit(hook: TransactionHook): void {
        this.beforeCommitHooks.push(hook);
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
            for (const hook of this.beforeCommitHooks) await hook();
        } catch (e) {
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
