import { IsolationLevel } from "../types.js";

export class TransactionAbortedError extends Error {
    constructor(cause?: unknown) {
        super("Transaction was already aborted before root scope completed", {
            cause,
        });
        this.name = "TransactionAbortedError";
    }
}

export class TransactionClosedError extends Error {
    constructor(operation: string = "Transaction") {
        super(`${operation} cannot use a transaction that has already closed`);
        this.name = "TransactionClosedError";
    }
}

export class UnsupportedNestedTransactionCapabilityError extends Error {
    constructor(operation: string = "Transaction capabilities") {
        super(`${operation} is not supported inside nested savepoints`);
        this.name = "UnsupportedNestedTransactionCapabilityError";
    }
}

export class IncompatibleIsolationLevelError extends Error {
    constructor(requested: IsolationLevel, current: IsolationLevel) {
        super(
            `A scope that requests isolation level ${requested} cannot join a transaction running at ${current}`
        );
        this.name = "IncompatibleIsolationLevelError";
    }
}
