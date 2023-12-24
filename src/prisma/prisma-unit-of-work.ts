import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";

import _ from "lodash";
import { Prisma, PrismaClient } from "@prisma/client";

import { UnitOfWork } from "Hexai/infra";

export interface PrismaTransactionOptions {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
}

let source: PrismaClient;
const als = new AsyncLocalStorage<
    [Prisma.TransactionClient, PrismaTransactionOptions?]
>();

async function doWrap<T>(
    fn: (client: Prisma.TransactionClient) => Promise<T>,
    options?: PrismaTransactionOptions,
    forceNew = false
): Promise<T> {
    assert(source, "Prisma client is not set.");

    const current = als.getStore();

    if (current && !forceNew) {
        const [tx, currentOptions] = current;

        if (options && !_.isEqual(options, currentOptions)) {
            throw new Error(
                "options cannot vary between nested uows.\n" +
                    "use '.wrapWithNew()' to start a new transaction with different options.\n" +
                    `current: ${JSON.stringify(currentOptions)}\n` +
                    `provided: ${JSON.stringify(options)}`
            );
        }

        return fn(tx);
    } else {
        return source.$transaction((tx) => {
            return als.run([tx, options], () => fn(tx));
        }, options);
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
    return await doWrap(fn, options, false);
}

async function wrapWithNew<T>(
    fn: (client: Prisma.TransactionClient) => Promise<T>,
    options?: PrismaTransactionOptions
): Promise<T> {
    return await doWrap(fn, options, true);
}

export function setClient(client: PrismaClient): void {
    source = client;
}

export const prismaUnitOfWork: UnitOfWork<
    Prisma.TransactionClient,
    PrismaTransactionOptions
> & {
    setClient(client: PrismaClient): void;
} = {
    getClient,
    wrap,
    wrapWithNew,
    setClient,
};
