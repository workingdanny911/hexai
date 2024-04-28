import { beforeEach, describe, expect, test } from "vitest";
import * as sqlite from "sqlite";
import sqlite3 from "sqlite3";
import { DummyMessage } from "@hexai/core/test";

import { SqliteIdempotencySupport } from "./sqlite-idempotency-support";

describe("SqliteIdempotencySupport", () => {
    let db: sqlite.Database;
    let support: SqliteIdempotencySupport;
    const message = DummyMessage.create();

    beforeEach(async () => {
        db = await sqlite.open({
            filename: ":memory:",
            driver: sqlite3.Database,
        });
        support = new SqliteIdempotencySupport(db);

        return async () => {
            await db.close();
        };
    });

    test.each([
        {
            description: "isDuplicate()",
            operation: () => support.isDuplicate("key", message),
        },
        {
            description: "markAsConsumed",
            operation: () => support.markAsProcessed("key", message),
        },
    ])("$description ensures table exists", async ({ operation }) => {
        await operation();

        const result = await db.get(`
            SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'idempotency'
        `);
        expect(result.count).toBe(1);
    });

    test("isDuplicate", async () => {
        await expect(support.isDuplicate("key", message)).resolves.toBe(false);

        await db.run(
            "INSERT INTO idempotency (key, message_id) VALUES (?, ?)",
            ["key", message.getMessageId()]
        );
        await expect(support.isDuplicate("key", message)).resolves.toBe(true);
    });

    test("markAsProcessed", async () => {
        await support.markAsProcessed("key", message);

        const result = await db.get("SELECT * FROM idempotency");
        expect(result).toEqual({
            key: "key",
            message_id: message.getMessageId(),
        });
    });
});
