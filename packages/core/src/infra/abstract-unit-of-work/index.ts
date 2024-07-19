export * from "./abstract-transaction";

import { AsyncLocalStorage } from "node:async_hooks";

import { Propagation, UnitOfWork } from "../unit-of-work";
import { AbstractTransaction } from "./abstract-transaction";

type ClientOf<T> = T extends AbstractTransaction<infer C, any> ? C : never;

type OptionsOf<T> = T extends AbstractTransaction<any, infer O> ? O : never;

export abstract class AbstractUnitOfWork<
    Tx extends AbstractTransaction<any, any>,
> implements UnitOfWork<ClientOf<Tx>, OptionsOf<Tx>>
{
    protected static transactionStorage = new AsyncLocalStorage<any>();
    protected transactionStorage: AsyncLocalStorage<any>;

    constructor() {
        this.transactionStorage = AbstractUnitOfWork.transactionStorage;
    }

    public getClient(): ClientOf<Tx> {
        const current = this.getCurrent();

        if (!current) {
            throw new Error("Unit of work not started");
        }

        return current.getClient();
    }

    protected getCurrent(): Tx | null {
        return this.transactionStorage.getStore() ?? null;
    }

    async wrap<R = unknown>(
        fn: (client: ClientOf<Tx>) => Promise<R>,
        options: Partial<OptionsOf<Tx>> = {}
    ): Promise<R> {
        const run = (tx: Tx) => tx.run(fn, options);

        if (options.propagation === Propagation.NEW) {
            return this.apply(await this.newTransaction(), run);
        }

        return this.apply(
            this.getCurrent() ?? (await this.newTransaction()),
            run
        );
    }

    protected abstract newTransaction(): Promise<Tx>;

    private apply<R>(
        transaction: Tx,
        callback: (transaction: Tx) => Promise<R>
    ): Promise<R> {
        return this.transactionStorage.run(transaction, () =>
            callback(transaction)
        );
    }
}
