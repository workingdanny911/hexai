import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import * as pg from "pg";

import { Message } from "@hexaijs/core";
import { waitForMs, waitForTicks } from "@hexaijs/core/test";
import {
    Application,
    ApplicationBuilder,
    ApplicationEventPublisher,
    Result,
    SimpleCompositeApplication,
} from "@hexaijs/application";
import {
    DefaultPostgresUnitOfWork,
    TransactionAbortedError,
} from "./postgres-unit-of-work.js";
import {
    newClient,
    useClient,
    useDatabase,
    useTableManager,
} from "./test-fixtures/index.js";

const DATABASE = "test_hexai__composite_application";
const TABLE = "_composite_writes";

class SomethingHappened extends Message<Record<never, never>> {
    static type = "test.something-happened";
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("SimpleCompositeApplication with DefaultPostgresUnitOfWork", () => {
    // requires admin privileges to create/drop databases
    useDatabase(DATABASE);
    const tableManager = useTableManager(DATABASE);
    const conn = useClient(DATABASE);
    const uow = new DefaultPostgresUnitOfWork(
        () => newClient(DATABASE),
        (c) => (c as pg.Client).end()
    );
    const event = new SomethingHappened({});

    beforeAll(async () => {
        await tableManager.createTable(TABLE, [
            { name: "id", property: "INT" },
        ]);
    });

    beforeEach(async () => {
        await tableManager.truncateTable(TABLE);
    });

    async function insertRecord(id: number): Promise<void> {
        await uow.withClient((client) =>
            client.query(`INSERT INTO ${TABLE} VALUES ($1);`, [id])
        );
    }

    async function committedIds(): Promise<number[]> {
        const result = await conn.query(`SELECT id FROM ${TABLE} ORDER BY id;`);
        return result.rows.map((row) => row.id);
    }

    function applicationHandling(handle: () => Promise<void>): Application {
        return new ApplicationBuilder()
            .withApplicationContext({})
            .withEventHandler(() => ({ canHandle: () => true, handle }))
            .build();
    }

    function failingApplication(): Application {
        return applicationHandling(async () => {
            throw new Error("application failed");
        });
    }

    function applicationFailingWithUndefined(): Application {
        return new ApplicationBuilder()
            .withApplicationContext({})
            .withEventInterceptor(async () => {
                throw undefined;
            })
            .build();
    }

    test("commits every application's writes when all succeed", async () => {
        const composite = new SimpleCompositeApplication(
            {
                first: applicationHandling(() => insertRecord(1)),
                second: applicationHandling(() => insertRecord(2)),
            },
            uow
        );

        const result = await composite.handleEvent(event);

        expect(result.isSuccess).toBe(true);
        expect(await committedIds()).toEqual([1, 2]);
    });

    test("rolls back after the slower application settles when another one fails", async () => {
        const slowApplicationGate = createDeferred();
        let isSlowWriteDone = false;
        const composite = new SimpleCompositeApplication(
            {
                failing: failingApplication(),
                slow: applicationHandling(async () => {
                    await slowApplicationGate.promise;
                    await insertRecord(1);
                    isSlowWriteDone = true;
                }),
            },
            uow
        );

        let isSettled = false;
        const handling = composite.handleEvent(event).finally(() => {
            isSettled = true;
        });
        await waitForTicks();

        expect(isSettled).toBe(false);

        slowApplicationGate.resolve();
        const result = await handling;

        expect(result.isError).toBe(true);
        expect(isSlowWriteDone).toBe(true);
        expect(await committedIds()).toEqual([]);
    });

    test("aborts an outer scope that publishes the event when an application fails", async () => {
        const composite = new SimpleCompositeApplication(
            {
                failing: failingApplication(),
                writing: applicationHandling(async () => {
                    await waitForMs(20);
                    await insertRecord(11);
                }),
            },
            uow
        );
        const results: Result<unknown>[] = [];
        const publisher = new ApplicationEventPublisher();
        publisher.subscribe(async (published) => {
            results.push(await composite.handleEvent(published));
        });

        await expect(
            uow.scope(async () => {
                await insertRecord(10);
                await publisher.publish(event);
            })
        ).rejects.toBeInstanceOf(TransactionAbortedError);

        expect(results.map((result) => result.isError)).toEqual([true]);
        expect(await committedIds()).toEqual([]);
    });

    test("rolls back when an application fails with undefined", async () => {
        const composite = new SimpleCompositeApplication(
            {
                failing: applicationFailingWithUndefined(),
                writing: applicationHandling(() => insertRecord(31)),
            },
            uow
        );

        const result = await composite.handleEvent(event);

        expect(result.isError).toBe(true);
        expect(await committedIds()).toEqual([]);
    });

    test("aborts an outer scope when an application fails with undefined", async () => {
        const composite = new SimpleCompositeApplication(
            {
                failing: applicationFailingWithUndefined(),
                writing: applicationHandling(() => insertRecord(41)),
            },
            uow
        );
        const results: Result<unknown>[] = [];

        await expect(
            uow.scope(async () => {
                await insertRecord(40);
                results.push(await composite.handleEvent(event));
            })
        ).rejects.toBeInstanceOf(TransactionAbortedError);

        expect(results.map((result) => result.isError)).toEqual([true]);
        expect(await committedIds()).toEqual([]);
    });

    test("commits nothing when an application fails inside a beforeCommit hook", async () => {
        const composite = new SimpleCompositeApplication(
            {
                failing: failingApplication(),
                writing: applicationHandling(() => insertRecord(21)),
            },
            uow
        );
        let hookEntries = 0;

        const outerScope = uow.scope(async () => {
            await insertRecord(20);
            uow.beforeCommit(async () => {
                hookEntries++;
                if (hookEntries > 1) {
                    throw new Error("beforeCommit hook re-entered");
                }
                await composite.handleEvent(event);
            });
        });

        // A scope() opened from a beforeCommit hook re-enters Postgres
        // transaction finalization, so how the outer scope itself settles is
        // a separate Postgres concern. Only the committed data is asserted.
        await outerScope.catch(() => undefined);

        expect(await committedIds()).toEqual([]);
    });
});
