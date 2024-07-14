import * as pg from "pg";
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

export class PostgresUnitOfWork extends AbstractUnitOfWork<
    pg.Client,
    PostgresTransactionOptions
> {
    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {
        super();
    }

    protected override makeOptions(
        options: Partial<PostgresTransactionOptions>
    ): PostgresTransactionOptions {
        return {
            propagation: Propagation.NESTED,
            ...options,
        };
    }

    protected override newTransaction(): AbstractTransaction<
        pg.Client,
        PostgresTransactionOptions
    > {
        return new PostgresTransaction(this.clientFactory, this.clientCleanUp);
    }
}

class PostgresTransaction extends AbstractTransaction<
    pg.Client,
    PostgresTransactionOptions
> {
    private originalClient!: pg.Client;
    private patchedClient!: pg.Client;

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {
        super();
    }

    public override getClient(): pg.Client {
        return this.patchedClient;
    }

    protected override async spawnNewClient(): Promise<void> {
        const client = await this.clientFactory();

        if (!(client instanceof pg.Client)) {
            throw new Error("Client factory must return a pg.Client");
        }

        await ensureConnection(client);

        this.setClient(client);
    }

    private setClient(client: pg.Client): void {
        this.originalClient = client;
        this.patchedClient = this.patchClient(client);
    }

    private patchClient(client: pg.Client): pg.Client {
        const isAborted = () => this.isAborted();

        return new Proxy(client, {
            get(target, prop, receiver) {
                if (prop === "query") {
                    if (isAborted()) {
                        throw new UnitOfWorkAbortedError(
                            "This unit of work is aborted"
                        );
                    }

                    return target.query.bind(target);
                }

                return Reflect.get(target, prop, receiver);
            },
        });
    }

    protected override async begin(): Promise<void> {
        const client = this.getClient();
        await client.query("BEGIN");

        if (this.getIsolationLevel() !== IsolationLevel.READ_COMMITTED) {
            await client.query(
                `SET TRANSACTION ISOLATION LEVEL ${this.getIsolationLevel()}`
            );
        }
    }

    protected override async enterSavepoint(level: number): Promise<void> {
        await this.getClient().query(`SAVEPOINT savepoint_${level}`);
    }

    protected override async rollbackToSavepoint(level: number): Promise<void> {
        await this.getClient().query(
            `ROLLBACK TO SAVEPOINT savepoint_${level}`
        );
    }

    protected override async annihilate(): Promise<void> {
        await this.clientCleanUp?.(this.originalClient);
    }

    protected override async rollback(): Promise<void> {
        await this.originalClient.query("ROLLBACK");
    }
    protected override async commit(): Promise<void> {
        await this.originalClient.query("COMMIT");
    }

    private getIsolationLevel(): IsolationLevel {
        return this.options.isolationLevel ?? IsolationLevel.READ_COMMITTED;
    }
}
