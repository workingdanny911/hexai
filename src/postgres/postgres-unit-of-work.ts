import * as pg from "pg";

import { Propagation, UnitOfWork } from "Hexai/infra";
import {
    ClientCleanUp,
    ClientFactory,
    PostgresTransactionOptions,
} from "./types";
import { Transaction } from "./transaction";

function bind(factory: ClientFactory, cleanUp?: ClientCleanUp): void {
    Transaction.setClientFactory(factory);

    if (cleanUp) {
        Transaction.setClientCleanUp(cleanUp);
    }
}

function getClient(): pg.Client {
    const current = Transaction.getCurrent();

    if (!current) {
        throw new Error("Unit of work not started");
    }

    return current.getClient();
}

async function wrap<T = unknown>(
    fn: (client: pg.Client) => Promise<T>,
    options: Partial<PostgresTransactionOptions> = {}
): Promise<T> {
    const transaction = Transaction.getCurrent();
    const startNew = options?.propagation === Propagation.NEW;

    if (!transaction || startNew) {
        return Transaction.startNew(fn, options);
    }

    transaction.setOptions(options);
    return transaction.run(fn);
}

export const postgresUnitOfWork: UnitOfWork<
    pg.Client,
    PostgresTransactionOptions
> & {
    bind: typeof bind;
} = {
    wrap,
    getClient,
    bind,
};
