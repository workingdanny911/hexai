import { Client } from "pg";
import {
    AbstractTransaction,
    AbstractUnitOfWork,
    IsolationLevel,
    Propagation,
    UnitOfWorkAbortedError,
} from "@hexai/core";

import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { ensureConnection } from "./helpers";

export class PostgresUnitOfWork extends AbstractUnitOfWork<PostgresTransaction> {
    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {
        super();
    }

    protected override async newTransaction(): Promise<PostgresTransaction> {
        return new PostgresTransaction(this.clientFactory, this.clientCleanUp);
    }
}

class PostgresTransaction extends AbstractTransaction<
    Client,
    PostgresTransactionOptions
> {
    private originalClient!: Client;
    private patchedClient!: Client;

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {
        super();
    }

    protected resolveOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.NESTED,
            ...options,
        };
    }

    protected async executeBegin(): Promise<void> {
        const client = this.getClient();
        await client.query("BEGIN");

        if (this.getIsolationLevel() !== IsolationLevel.READ_COMMITTED) {
            await client.query(
                `SET TRANSACTION ISOLATION LEVEL ${this.getIsolationLevel()}`
            );
        }
    }

    public override getClient(): Client {
        return this.patchedClient;
    }

    protected override async initialize(): Promise<void> {
        const client = await this.clientFactory();

        if (!(client instanceof Client)) {
            throw new Error("Client factory must return a pg.Client instance");
        }

        await ensureConnection(client);

        this.setClient(client);
    }

    private setClient(client: Client): void {
        this.originalClient = client;
        this.patchedClient = this.patchClient(client);
    }

    private patchClient(client: Client): Client {
        const isAbort = () => this.isAbort();
        const isExited = () => this.isExited();

        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    if (isAbort() || isExited()) {
                        throw new UnitOfWorkAbortedError(
                            "This unit of work is aborted or closed."
                        );
                    }

                    return target.query.bind(target);
                }

                return Reflect.get(target, prop, receiver);
            },
        });
    }

    protected override async executeSavepoint(): Promise<void> {
        await this.getClient().query(`SAVEPOINT sp_${this.currentLevel}`);
    }

    protected override async executeRollbackToSavepoint(): Promise<void> {
        await this.getClient().query(
            `ROLLBACK TO SAVEPOINT sp_${this.currentLevel}`
        );
    }

    protected override async annihilate(): Promise<void> {
        await this.clientCleanUp?.(this.originalClient);
    }

    protected override async executeRollback(): Promise<void> {
        await this.originalClient.query("ROLLBACK");
    }

    protected override async executeCommit(): Promise<void> {
        await this.originalClient.query("COMMIT");
    }

    private getIsolationLevel(): IsolationLevel {
        return this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
    }
}
