import { DataSource, QueryRunner } from "typeorm";
import {
    AbstractTransaction,
    AbstractUnitOfWork,
    CommonUnitOfWorkOptions,
    Propagation,
} from "@hexai/core";

export class TypeormUnitOfWork extends AbstractUnitOfWork<TypeormTransaction> {
    constructor(private dataSource: DataSource) {
        super();
    }

    protected async newTransaction(): Promise<TypeormTransaction> {
        return new TypeormTransaction(this.dataSource.createQueryRunner());
    }
}

class TypeormTransaction extends AbstractTransaction<
    QueryRunner,
    CommonUnitOfWorkOptions
> {
    constructor(private queryRunner: QueryRunner) {
        super();
    }

    public override getClient(): QueryRunner {
        return this.queryRunner;
    }

    protected override resolveOptions(
        options: Partial<CommonUnitOfWorkOptions>
    ): CommonUnitOfWorkOptions {
        return {
            propagation: Propagation.NESTED,
            ...options,
        };
    }

    protected override async initialize(): Promise<void> {
        return;
    }

    protected override async executeBegin(): Promise<void> {
        await this.queryRunner.startTransaction();
    }

    protected override async executeCommit(): Promise<void> {
        await this.queryRunner.commitTransaction();
    }

    protected override async executeRollback(): Promise<void> {
        await this.queryRunner.rollbackTransaction();
    }

    protected override async executeSavepoint(): Promise<void> {
        await this.queryRunner.query(`SAVEPOINT ${this.getSavepointName()}`);
    }

    private getSavepointName() {
        return `sp_${this.currentLevel}`;
    }

    protected override async executeRollbackToSavepoint(): Promise<void> {
        await this.queryRunner.query(
            `ROLLBACK TO SAVEPOINT ${this.getSavepointName()}`
        );
    }
}
