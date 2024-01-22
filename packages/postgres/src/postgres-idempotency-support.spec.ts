import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DummyMessage } from "@hexai/core/test";
import { replaceDatabaseNameIn } from "@hexai/core/utils";

import { DB_URL } from "@/config";
import { createTestContext } from "@/test";
import { PostgresUnitOfWork } from "@/postgres-unit-of-work";
import { PostgresIdempotencySupport } from "@/postgres-idempotency-support";

describe("PostgresIdempotencySupport", () => {
    const { client, setup, teardown, tableManager } = createTestContext(
        replaceDatabaseNameIn(DB_URL, "test_idempotency_support")
    );
    const support = new PostgresIdempotencySupport(
        new PostgresUnitOfWork(() => client)
    );
    const message = DummyMessage.create();

    beforeAll(async () => {
        await setup();

        return async () => {
            await teardown();
        };
    });

    beforeEach(async () => {
        await tableManager.truncateAllTables();
    });

    test("marking message as processed", async () => {
        await support.markAsProcessed("key", message);

        const result = await client.query(
            "SELECT * FROM hexai__idempotency_support WHERE key = $1 AND message_id = $2",
            ["key", message.getMessageId()]
        );

        expect(result.rows[0]).toContain({
            key: "key",
            message_id: message.getMessageId(),
        });
    });

    test("when message is not processed", async () => {
        const isDuplicate = await support.isDuplicate("key", message);

        expect(isDuplicate).toBe(false);
    });

    test("when message is processed", async () => {
        await support.markAsProcessed("key", message);
        const isDuplicate = await support.isDuplicate("key", message);

        expect(isDuplicate).toBe(true);
    });

    test("when message is processed with different key", async () => {
        await support.markAsProcessed("key", message);
        const isDuplicate = await support.isDuplicate("another-key", message);

        expect(isDuplicate).toBe(false);
    });
});
