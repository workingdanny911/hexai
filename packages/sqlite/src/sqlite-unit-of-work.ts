import type { Database } from "sqlite";

import { UnitOfWork } from "@hexaijs/core";

export class SqliteUnitOfWork implements UnitOfWork<Database> {
    private static transactions = new WeakMap<
        Database,
        {
            level: number;
            aborted: boolean;
        }
    >();

    constructor(private db: Database) {
        if (!SqliteUnitOfWork.transactions.has(db)) {
            SqliteUnitOfWork.transactions.set(db, {
                level: 0,
                aborted: false,
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

    async wrap<T>(fn: (client: Database) => Promise<T>): Promise<T> {
        const current = SqliteUnitOfWork.transactions.get(this.db)!;
        if (++current.level === 1) {
            await this.db.run("BEGIN TRANSACTION");
        }

        try {
            return await fn(this.db);
        } catch (e) {
            if (!current.aborted) {
                current.aborted = true;
            }

            throw e;
        } finally {
            if (--current.level === 0) {
                if (current.aborted) {
                    await this.db.run("ROLLBACK");
                } else {
                    await this.db.run("COMMIT");
                }
            }
        }
    }
}
