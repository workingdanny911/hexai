import type * as pg from "pg";
import { beforeAll, beforeEach, expect } from "vitest";

import {
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
} from "../postgres-unit-of-work.js";
import { newClient, useClient, useDatabase, useTableManager } from "./hooks.js";

export const TABLE = "_test";

export async function getTransactionId(client: pg.ClientBase): Promise<string> {
    const result = await client.query(`SELECT txid_current();`);
    return result.rows[0].txid_current;
}

export function areSameTransaction(...txids: string[]): boolean {
    return new Set(txids).size === 1;
}

export function areDistinctTransactions(...txids: string[]): boolean {
    return new Set(txids).size === txids.length;
}

// Returns undefined when nothing throws, unlike captureThrown in
// async.fixtures.ts, which fails the test.
export function captureSyncError(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
}

export function expectNoActiveTransaction(error: unknown): void {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/not started/);
}

export async function expectTransactionAborted(
    promise: Promise<unknown>,
    cause: unknown
): Promise<void> {
    let error: unknown;
    try {
        await promise;
    } catch (e) {
        error = e;
    }

    expect(error).toBeInstanceOf(TransactionAbortedError);
    expect((error as Error).cause).toBe(cause);
}

// Creates the database with one table of record ids, emptied before every
// test, and returns a unit of work over that database with helpers that
// insert and check records.
export function useUnitOfWorkTestContext(database: string) {
    // requires admin privileges to create/drop databases
    useDatabase(database);
    const tableManager = useTableManager(database);
    const conn = useClient(database);
    const uow = new DefaultPostgresUnitOfWork(
        () => newClient(database),
        (c) => (c as pg.Client).end()
    );

    let verificationRepo: {
        exists: (id: number) => Promise<boolean>;
        count: () => Promise<number>;
    };

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [
            { name: "id", property: "INT" },
        ]);

        verificationRepo = {
            async exists(id: number): Promise<boolean> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE} WHERE id = $1;`,
                    [id]
                );
                return result.rows[0].count > 0;
            },
            async count(): Promise<number> {
                const result = await conn.query(
                    `SELECT COUNT(*) FROM ${TABLE};`
                );
                return parseInt(result.rows[0].count);
            },
        };
    });

    beforeEach(async () => {
        await tableManager.truncateTable(TABLE);
    });

    async function insertRecord(
        client: pg.ClientBase,
        id: number
    ): Promise<void> {
        await client.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id]);
    }

    async function expectRecordExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(true);
    }

    async function expectRecordNotExists(id: number): Promise<void> {
        expect(await verificationRepo.exists(id)).toBe(false);
    }

    async function expectRecordCount(count: number): Promise<void> {
        expect(await verificationRepo.count()).toBe(count);
    }

    return {
        uow,
        insertRecord,
        expectRecordExists,
        expectRecordNotExists,
        expectRecordCount,
    };
}
