import { Database } from "sqlite";
import { CommonUnitOfWorkOptions, UnitOfWork } from "../../infra";
export declare class SqliteUnitOfWork implements UnitOfWork<Database> {
    private db;
    private static transactions;
    constructor(db: Database);
    getClient(): Database;
    wrap<T>(fn: (client: Database) => Promise<T>, options?: Partial<CommonUnitOfWorkOptions>): Promise<T>;
}
//# sourceMappingURL=sqlite-unit-of-work.d.ts.map