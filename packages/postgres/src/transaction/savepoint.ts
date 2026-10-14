import { AsyncLocalStorage } from "node:async_hooks";

import { TransactionClosedError } from "./errors.js";

// The savepoint whose callback is running, so a NESTED scope can tell a child
// of the open savepoint from a sibling that would interleave with it.
export const savepointScope = new AsyncLocalStorage<Savepoint>();

export interface SavepointHost {
    admitsWork(): boolean;
    send(sql: string): Promise<unknown>;
    remove(savepoint: Savepoint): void;
}

export class Savepoint {
    private closed = false;

    constructor(
        private readonly name: string,
        private readonly host: SavepointHost
    ) {}

    public async execute<T>(fn: () => Promise<T>): Promise<T> {
        await this.host.send(`SAVEPOINT ${this.name}`);
        // The outcome may have been decided while SAVEPOINT was pending, and
        // every query of the callback would be refused.
        if (!this.host.admitsWork()) {
            this.closed = true;
            throw new TransactionClosedError("Nested savepoint");
        }

        let result: T;
        try {
            result = await savepointScope.run(this, fn);
        } catch (failure) {
            await this.rollBackAfter(failure);
            throw failure;
        }
        await this.end(`RELEASE SAVEPOINT ${this.name}`);
        return result;
    }

    public isClosed(): boolean {
        return this.closed;
    }

    // The callback's failure is what its caller needs to see, so a failed
    // ROLLBACK TO SAVEPOINT, for example one refused because the transaction
    // was decided meanwhile, is only reported.
    private async rollBackAfter(failure: unknown): Promise<void> {
        try {
            await this.end(`ROLLBACK TO SAVEPOINT ${this.name}`);
        } catch (rollbackFailure) {
            console.error(
                "PostgresUnitOfWork could not roll back to a savepoint after a failure",
                rollbackFailure,
                failure
            );
        }
    }

    private async end(statement: string): Promise<void> {
        this.closed = true;
        await this.host.send(statement);
        this.host.remove(this);
    }
}
