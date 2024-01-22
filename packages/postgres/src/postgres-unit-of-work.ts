import { AsyncLocalStorage } from "node:async_hooks";

import * as pg from "pg";
import { Propagation } from "@hexai/core";

import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { Transaction } from "./transaction";

function makeOptions(
    options: Partial<PostgresTransactionOptions> = {}
): PostgresTransactionOptions {
    return {
        propagation: Propagation.NESTED,
        ...options,
    };
}

export class PostgresUnitOfWork {
    private transactionStorage = new AsyncLocalStorage<Transaction>();

    constructor(
        private clientFactory: ClientFactory,
        private clientCleanUp?: ClientCleanUp
    ) {}

    getClient(): pg.Client {
        const current = this.getCurrent();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    private getCurrent(): Transaction | null {
        return this.transactionStorage.getStore() ?? null;
    }

    async wrap<T = unknown>(
        fn: (client: pg.Client) => Promise<T>,
        options: Partial<PostgresTransactionOptions> = {}
    ): Promise<T> {
        const run = (t: Transaction) => t.run(fn, makeOptions(options));

        if (options?.propagation === Propagation.NEW) {
            return this.apply(this.newTransaction(), run);
        }

        return this.apply(this.getCurrent() ?? this.newTransaction(), run);
    }

    private newTransaction() {
        return new Transaction(this.clientFactory, this.clientCleanUp);
    }

    private apply<T>(
        transaction: Transaction,
        callback: (transaction: Transaction) => Promise<T>
    ): Promise<T> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}
