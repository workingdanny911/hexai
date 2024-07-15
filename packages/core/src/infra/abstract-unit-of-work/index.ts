export * from "./abstract-transaction";

import { AsyncLocalStorage } from "node:async_hooks";

import { AbstractTransaction } from "./abstract-transaction";
import {
    CommonUnitOfWorkOptions,
    Propagation,
    UnitOfWork,
} from "../unit-of-work";

export abstract class AbstractUnitOfWork<
    C,
    O extends CommonUnitOfWorkOptions = CommonUnitOfWorkOptions,
> implements UnitOfWork<C, O>
{
    protected transactionStorage = new AsyncLocalStorage<
        AbstractTransaction<C, O>
    >();

    protected abstract resolveOptions(options: Partial<O>): O;

    public getClient(): C {
        const current = this.getCurrent();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    protected getCurrent(): AbstractTransaction<C, O> | null {
        return this.transactionStorage.getStore() ?? null;
    }

    async wrap<T = unknown>(
        fn: (client: C) => Promise<T>,
        options: Partial<O> = {}
    ): Promise<T> {
        const resolvedOptions = this.resolveOptions(options);

        const run = (tx: AbstractTransaction<C, O>) =>
            tx.run(fn, resolvedOptions);

        if (resolvedOptions.propagation === Propagation.NEW) {
            return this.apply(this.newTransaction(), run);
        }

        return this.apply(this.getCurrent() ?? this.newTransaction(), run);
    }

    protected abstract newTransaction(): AbstractTransaction<C, O>;

    private apply<T>(
        transaction: AbstractTransaction<C, O>,
        callback: (transaction: AbstractTransaction<C, O>) => Promise<T>
    ): Promise<T> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}
