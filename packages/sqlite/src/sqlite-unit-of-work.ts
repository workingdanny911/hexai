import type { Database } from "sqlite";

import { TransactionHooks, UnitOfWork } from "@hexaijs/core";
import type { TransactionHook } from "@hexaijs/core";

export class SqliteUnitOfWork implements UnitOfWork<Database> {
    private static transactions = new WeakMap<
        Database,
        {
            level: number;
            aborted: boolean;
            hooks: TransactionHooks;
        }
    >();

    constructor(private db: Database) {
        if (!SqliteUnitOfWork.transactions.has(db)) {
            SqliteUnitOfWork.transactions.set(db, {
                level: 0,
                aborted: false,
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

    beforeCommit(hook: TransactionHook): void {
        const current = this.getRequiredState("beforeCommit");
        current.hooks.addBeforeCommit(hook);
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
            await this.db.run("BEGIN TRANSACTION");
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

                current.hooks = new TransactionHooks();
                current.aborted = false;

                if (wasAborted) {
                    await hooks.executeRollback(
                        async () => { await this.db.run("ROLLBACK"); },
                        abortError
                    );
                } else {
                    await hooks.executeCommit(
                        async () => { await this.db.run("COMMIT"); },
                        async () => { await this.db.run("ROLLBACK"); }
                    );
                }
            }
        }
    }

    private getRequiredState(hookName: string) {
        const current = SqliteUnitOfWork.transactions.get(this.db);
        if (!current || current.level === 0) {
            throw new Error(
                `Cannot register ${hookName} hook outside of a transaction scope`
            );
        }
        return current;
    }
}
