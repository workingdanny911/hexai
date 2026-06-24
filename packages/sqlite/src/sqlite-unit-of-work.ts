import { TransactionHooks } from "@hexaijs/core";

import type { Database } from "better-sqlite3";
import type {
    BeforeCommitOptions,
    TransactionHook,
    UnitOfWork,
} from "@hexaijs/core";

export class SqliteUnitOfWork implements UnitOfWork<Database> {
    private static transactions = new WeakMap<
        Database,
        {
            level: number;
            aborted: boolean;
            finalizing: "commit" | "rollback" | null;
            hooks: TransactionHooks;
        }
    >();

    constructor(private db: Database) {
        if (!SqliteUnitOfWork.transactions.has(db)) {
            SqliteUnitOfWork.transactions.set(db, {
                level: 0,
                aborted: false,
                finalizing: null,
                hooks: new TransactionHooks(),
            });
        }
    }

    getClient(): Database {
        const current = SqliteUnitOfWork.transactions.get(this.db);
        if (!current || current.level === 0) {
            throw new Error("No transaction is active");
        }
        return this.db;
    }

    beforeCommit(
        hook: TransactionHook,
        options?: BeforeCommitOptions
    ): void {
        const current = this.getRequiredState("beforeCommit");
        current.hooks.addBeforeCommit(hook, options?.phase);
    }

    afterCommit(hook: TransactionHook): void {
        const current = this.getRequiredState("afterCommit");
        current.hooks.addAfterCommit(hook);
    }

    afterRollback(hook: TransactionHook): void {
        const current = this.getRequiredState("afterRollback");
        current.hooks.addAfterRollback(hook);
    }

    async scope<T>(fn: () => Promise<T>): Promise<T> {
        return this.wrap(fn);
    }

    async wrap<T>(fn: (client: Database) => Promise<T>): Promise<T> {
        const current = SqliteUnitOfWork.transactions.get(this.db)!;
        if (++current.level === 1) {
            this.db.exec("BEGIN TRANSACTION");
        }

        let abortError: unknown;
        try {
            return await fn(this.db);
        } catch (e) {
            if (!current.aborted) {
                current.aborted = true;
            }
            abortError = e;

            throw e;
        } finally {
            if (--current.level === 0) {
                const hooks = current.hooks;
                const wasAborted = current.aborted;

                current.finalizing = wasAborted ? "rollback" : "commit";
                try {
                    if (wasAborted) {
                        await hooks.executeRollback(
                            async () => { this.db.exec("ROLLBACK"); },
                            abortError
                        );
                    } else {
                        await hooks.executeCommit(
                            async () => { this.db.exec("COMMIT"); },
                            async () => { this.db.exec("ROLLBACK"); }
                        );
                    }
                } finally {
                    current.hooks = new TransactionHooks();
                    current.aborted = false;
                    current.finalizing = null;
                }
            }
        }
    }

    private getRequiredState(hookName: string) {
        const current = SqliteUnitOfWork.transactions.get(this.db);
        const isCommitFinalizingBeforeCommit =
            hookName === "beforeCommit" && current?.finalizing === "commit";
        if (
            !current ||
            (current.level === 0 && !isCommitFinalizingBeforeCommit)
        ) {
            throw new Error(
                `Cannot register ${hookName} hook outside of a transaction scope`
            );
        }
        return current;
    }
}
