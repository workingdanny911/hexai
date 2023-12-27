import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";

import {
    BaseUnitOfWorkOptions,
    IsolationLevel,
    Propagation,
    UnitOfWork,
} from "@hexai/core/infra";
import { Prisma, PrismaClient } from "./client";

export interface PrismaTransactionOptions extends BaseUnitOfWorkOptions {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: IsolationLevel;
}

let source: PrismaClient;
const als = new AsyncLocalStorage<[any, PrismaTransactionOptions?]>();

async function doWrap<C extends Prisma.TransactionClient, R>(
    fn: (client: C) => Promise<R>,
    options?: PrismaTransactionOptions
): Promise<R> {
    assert(source, "Prisma client is not set.");

    const current = als.getStore();

    if (current && options?.propagation !== Propagation.NEW) {
        const [tx] = current;
        return fn(tx);
    } else {
        const isolationLevel = translateIsolationLevel(options?.isolationLevel);
        return source.$transaction(
            (tx) => {
                return als.run([tx, options], () => fn(tx as C));
            },
            {
                maxWait: options?.maxWait,
                timeout: options?.timeout,
                isolationLevel,
            }
        );
    }
}

function translateIsolationLevel(
    isolationLevel?: IsolationLevel
): Prisma.TransactionIsolationLevel | undefined {
    switch (isolationLevel) {
        case IsolationLevel.READ_UNCOMMITTED:
            return "ReadUncommitted";
        case IsolationLevel.READ_COMMITTED:
            return "ReadCommitted";
        case IsolationLevel.REPEATABLE_READ:
            return "RepeatableRead";
        case IsolationLevel.SERIALIZABLE:
            return "Serializable";
        default:
            return undefined;
    }
}

function getClient<T extends Prisma.TransactionClient>(): T {
    const current = als.getStore();
    assert(
        current,
        "UnitOfWork not started. You can only get the client inside a UnitOfWork."
    );
    return current[0] as T;
}

async function wrap<C extends Prisma.TransactionClient, R>(
    fn: (client: C) => Promise<R>,
    options?: PrismaTransactionOptions
): Promise<R> {
    return await doWrap(fn, options);
}

export function bindClient<T extends PrismaClient>(client: T): void {
    source = client;
}

export const prismaUnitOfWork: UnitOfWork<any, PrismaTransactionOptions> & {
    bindClient<T extends PrismaClient>(client: T): void;
} = {
    getClient,
    wrap,
    bindClient,
};
