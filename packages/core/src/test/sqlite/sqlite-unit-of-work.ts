import { Database } from "sqlite";

import {
    AbstractTransaction,
    AbstractUnitOfWork,
    CommonUnitOfWorkOptions,
    Propagation,
    UnitOfWorkAbortedError,
} from "@/infra";

export class SqliteUnitOfWork extends AbstractUnitOfWork<SqliteTransaction> {
    constructor(
        private connFactory: () => Promise<Database>,
        private cleanUp?: (client: Database) => Promise<void>
    ) {
        super();
    }

    protected async newTransaction(): Promise<SqliteTransaction> {
        return new SqliteTransaction(this.connFactory, this.cleanUp);
    }
}

export class SqliteTransaction extends AbstractTransaction<Database> {
    private client!: Database;

    constructor(
        private connFactory: () => Promise<Database>,
        private cleanUp?: (client: Database) => Promise<void>
    ) {
        super();
    }

    public override getClient(): Database {
        return this.client;
    }

    protected resolveOptions(options: Partial<CommonUnitOfWorkOptions>) {
        return {
            propagation: Propagation.EXISTING,
            ...options,
        };
    }

    protected async initialize(): Promise<void> {
        this.client = await this.connFactory();
    }

    protected async executeBegin(): Promise<void> {
        await this.client.exec("BEGIN");
    }

    protected async executeCommit(): Promise<void> {
        await this.client.exec("COMMIT");
    }

    protected async executeRollback(): Promise<void> {
        try {
            await this.client.exec("ROLLBACK");
        } catch (e) {
            if (this.isDatabaseClosedError(e)) {
                throw new UnitOfWorkAbortedError(
                    `Transaction aborted: ${(e as Error).message}`
                );
            }

            throw e;
        }
    }

    private isDatabaseClosedError(e: any): boolean {
        return e?.message.match(/database is closed/i);
    }

    protected async executeSavepoint(): Promise<void> {
        await this.client.exec(`SAVEPOINT sp_${this.currentLevel}`);
    }

    protected async executeRollbackToSavepoint(): Promise<void> {
        await this.client.exec(`ROLLBACK TO sp_${this.currentLevel}`);
    }

    protected async annihilate(): Promise<void> {
        if (this.cleanUp) {
            await this.cleanUp(this.client);
        }
    }
}
