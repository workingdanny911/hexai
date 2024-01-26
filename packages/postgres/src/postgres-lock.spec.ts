import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { replaceDatabaseNameIn } from "@hexai/core/utils";
import { waitForMs } from "@hexai/core/test";

import { createTestContext } from "@/test";
import { DB_URL } from "@/config";
import { PostgresLock } from "@/postgres-lock";

describe("PostgresLock", () => {
    const testContext = createTestContext(
        replaceDatabaseNameIn(DB_URL, "test_lock")
    );
    const client = testContext.client;
    let lock: PostgresLock;

    beforeAll(async () => {
        await testContext.setup();

        return async () => {
            await testContext.teardown();
        };
    });

    beforeEach(async () => {
        lock = createLock();
        await testContext.tableManager.truncateTable("hexai__locks");
    });

    async function hasLock() {
        const result = await client.query(
            "SELECT * FROM hexai__locks WHERE name = $1",
            ["test_lock"]
        );
        return result.rowCount === 1;
    }

    test("cannot acquire when client is not set", async () => {
        await expect(
            new PostgresLock("test_lock").acquire()
        ).rejects.toThrowError("client not set");
    });

    test("acquiring", async () => {
        const acquired = await lock.acquire();

        expect(acquired).toBe(true);
        expect(await hasLock()).toBe(true);
    });

    function createLock() {
        const lock = new PostgresLock("test_lock", 1000);
        lock.setClient(client);
        return lock;
    }

    test("acquiring when lock is already acquired", async () => {
        const anotherLock = createLock();

        expect(await lock.acquire()).toBe(true);
        expect(await anotherLock.acquire()).toBe(false);
    });

    test("acquiring the same lock when lock is already acquired", async () => {
        await lock.acquire();

        const acquired = await lock.acquire();

        expect(acquired).toBe(true);
    });

    test("extends expiry when lock is already acquired", async () => {
        const anotherLock = createLock();
        await lock.acquire();
        await waitForMs(500);

        expect(await lock.acquire()).toBe(true);

        await waitForMs(900);
        expect(await anotherLock.acquire()).toBe(false);

        await waitForMs(500);
        expect(await anotherLock.acquire()).toBe(true);
    });

    test("removes expired lock", async () => {
        await lock.acquire();
        const anotherLock = createLock();

        expect(await anotherLock.acquire()).toBe(false);
        await waitForMs(1000);

        expect(await anotherLock.acquire()).toBe(true);
    });

    test("cannot release when client is not set", async () => {
        await expect(
            new PostgresLock("test_lock").release()
        ).rejects.toThrowError("client not set");
    });

    test("releasing", async () => {
        await lock.acquire();

        await lock.release();

        expect(await hasLock()).toBe(false);
    });
});
