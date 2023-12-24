import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";

import {
    BaseUnitOfWorkOptions,
    IsolationLevel,
    Propagation,
    UnitOfWork,
} from "Hexai/infra";

export interface PrismaTransactionOptions extends BaseUnitOfWorkOptions {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: IsolationLevel;
}

let source: PrismaClient;
const als = new AsyncLocalStorage<
    [Prisma.TransactionClient, PrismaTransactionOptions?]
>();

async function doWrap<T>(
    fn: (client: Prisma.TransactionClient) => Promise<T>,
    options?: PrismaTransactionOptions
): Promise<T> {
    assert(source, "Prisma client is not set.");

    const current = als.getStore();

    if (current && options?.propagation !== Propagation.NEW) {
        const [tx] = current;
        return fn(tx);
    } else {
        const isolationLevel = translateIsolationLevel(options?.isolationLevel);
        return source.$transaction(
            (tx) => {
                return als.run([tx, options], () => fn(tx));
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
            return Prisma.TransactionIsolationLevel.ReadUncommitted;
        case IsolationLevel.READ_COMMITTED:
            return Prisma.TransactionIsolationLevel.ReadCommitted;
        case IsolationLevel.REPEATABLE_READ:
            return Prisma.TransactionIsolationLevel.RepeatableRead;
        case IsolationLevel.SERIALIZABLE:
            return Prisma.TransactionIsolationLevel.Serializable;
        default:
            return undefined;
    }
}

function getClient(): Prisma.TransactionClient {
    const current = als.getStore();
    assert(
        current,
        "UnitOfWork not started. You can only get the client inside a UnitOfWork."
    );
    return current[0];
}

async function wrap<T>(
    fn: (client: Prisma.TransactionClient) => Promise<T>,
    options?: PrismaTransactionOptions
): Promise<T> {
    return await doWrap(fn, options);
}

export function bindClient(client: PrismaClient): void {
    source = client;
}

export const prismaUnitOfWork: UnitOfWork<
    Prisma.TransactionClient,
    PrismaTransactionOptions
> & {
    bindClient(client: PrismaClient): void;
} = {
    getClient,
    wrap,
    bindClient,
};
