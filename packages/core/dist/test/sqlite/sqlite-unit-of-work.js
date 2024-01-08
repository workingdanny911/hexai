"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteUnitOfWork = void 0;
class SqliteUnitOfWork {
    db;
    static transactions = new WeakMap();
    constructor(db) {
        this.db = db;
        if (!SqliteUnitOfWork.transactions.has(db)) {
            SqliteUnitOfWork.transactions.set(db, {
                level: 0,
                aborted: false,
            });
        }
    }
    getClient() {
        return this.db;
    }
    async wrap(fn, options) {
        const current = SqliteUnitOfWork.transactions.get(this.db);
        if (++current.level === 1) {
            await this.db.run("BEGIN TRANSACTION");
        }
        try {
            return await fn(this.db);
        }
        catch (e) {
            if (!current.aborted) {
                current.aborted = true;
            }
            throw e;
        }
        finally {
            if (--current.level === 0) {
                if (current.aborted) {
                    await this.db.run("ROLLBACK");
                }
                else {
                    await this.db.run("COMMIT");
                }
            }
        }
    }
}
exports.SqliteUnitOfWork = SqliteUnitOfWork;
//# sourceMappingURL=sqlite-unit-of-work.js.map