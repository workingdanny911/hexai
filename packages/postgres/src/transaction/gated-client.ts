import type * as pg from "pg";

export interface QueryGate {
    send(args: unknown[]): Promise<pg.QueryResult>;
    submit(args: unknown[]): void;
}

export interface SubmittableQuery {
    handleReadyForQuery(...args: unknown[]): unknown;
    handleError(failure: unknown, ...args: unknown[]): unknown;
}

// pg ends a submittable's use of the connection with exactly one of these
// calls: handleReadyForQuery after it completes, or handleError when the
// server reports an error, the query cannot be sent or the connection is lost.
// pg's own queries settle their promises on the same two calls.
export function watchSubmittableEnd(
    submittable: SubmittableQuery,
    listener: { onFailure(failure: unknown): void; onEnd(): void }
): void {
    const handleReadyForQuery = submittable.handleReadyForQuery;
    const handleError = submittable.handleError;
    let ended = false;
    const end = () => {
        if (ended) {
            return;
        }
        ended = true;
        listener.onEnd();
    };

    submittable.handleReadyForQuery = function (...args) {
        try {
            return handleReadyForQuery.apply(this, args);
        } finally {
            end();
        }
    };
    submittable.handleError = function (failure, ...args) {
        listener.onFailure(failure);
        try {
            return handleError.call(this, failure, ...args);
        } finally {
            end();
        }
    };
}

type QueryCallback = (error: unknown, result?: pg.QueryResult) => void;

// The connection belongs to the unit of work for the whole transaction:
// releasing, ending or reconnecting it from inside would hand it to another
// borrower or break the transaction.
const TRANSACTION_OWNED_MEMBERS: ReadonlySet<PropertyKey> = new Set([
    "release",
    "end",
    "connect",
]);

class TransactionOwnsClientError extends Error {
    constructor(member: string) {
        super(
            `${member}() cannot be called on a client a transaction owns; the unit of work releases it when the transaction ends`
        );
        this.name = "TransactionOwnsClientError";
    }
}

/**
 * The client that code inside a transaction receives. Its queries go through
 * the transaction: refused once the transaction stops accepting work,
 * otherwise sent one at a time ahead of the final statement. A query in
 * callback form takes the same way and gets its result through the callback.
 * A submittable, such as a cursor, is returned at once and sent when its turn
 * comes, as pg does: within the call on an idle connection, later on a busy
 * one.
 * Every other member is the real client's, called on it, and a method that
 * returns the real client returns this one instead.
 */
export function createGatedClient(
    client: pg.ClientBase,
    gate: QueryGate
): pg.ClientBase {
    const delegates = new Map<
        PropertyKey,
        { original: unknown; delegate: unknown }
    >();
    const query = (...args: unknown[]): unknown =>
        routeQuery(gate, args);

    const gated: pg.ClientBase = new Proxy(client, {
        get(target, property) {
            if (property === "query") {
                return query;
            }
            if (TRANSACTION_OWNED_MEMBERS.has(property)) {
                return () => {
                    throw new TransactionOwnsClientError(String(property));
                };
            }

            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
                return value;
            }
            const known = delegates.get(property);
            if (known?.original === value) {
                return known.delegate;
            }
            const original = value as (...args: unknown[]) => unknown;
            const delegate = (...args: unknown[]): unknown => {
                const result = original.apply(target, args);
                return result === target ? gated : result;
            };
            delegates.set(property, { original, delegate });
            return delegate;
        },
    });
    return gated;
}

function routeQuery(gate: QueryGate, args: unknown[]): unknown {
    if (isSubmittable(args[0])) {
        gate.submit(args);
        return args[0];
    }

    const { queryArgs, callback } = takeQueryCallback(args);
    const result = gate.send(copyQueryConfig(queryArgs));
    if (!callback) {
        return result;
    }
    result.then(
        (queryResult) => callback(null, queryResult),
        (error: unknown) => callback(error)
    );
    return undefined;
}

// pg takes the callback as the last argument or as the config's `callback`.
function takeQueryCallback(args: unknown[]): {
    queryArgs: unknown[];
    callback?: QueryCallback;
} {
    const last = args[args.length - 1];
    if (args.length > 1 && typeof last === "function") {
        return {
            queryArgs: args.slice(0, -1),
            callback: last as QueryCallback,
        };
    }

    const [config, ...rest] = args;
    if (
        typeof config === "object" &&
        config !== null &&
        typeof (config as { callback?: unknown }).callback === "function"
    ) {
        const { callback, ...queryConfig } = config as {
            callback: QueryCallback;
        };
        return { queryArgs: [queryConfig, ...rest], callback };
    }
    return { queryArgs: args };
}

// pg reads a query config when query() is called, while the line may send the
// query later, so the line gets the config as it was at the call. The copy
// keeps the prototype, where a config class such as an SQL template keeps
// getters like `text`.
function copyQueryConfig(args: unknown[]): unknown[] {
    const [config, ...rest] = args;
    if (typeof config !== "object" || config === null) {
        return args;
    }
    const copy: object = Object.assign(
        Object.create(Object.getPrototypeOf(config) as object | null) as object,
        config
    );
    return [copy, ...rest];
}

function isSubmittable(value: unknown): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { submit?: unknown }).submit === "function"
    );
}
