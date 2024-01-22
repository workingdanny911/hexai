import { beforeEach, describe, expect, it, test } from "vitest";
import * as sqlite from "sqlite";
import { Message } from "@hexai/core";
import { DummyMessage } from "@hexai/core/test";
import { SqliteOutbox } from "@/test/sqlite-outbox";

describe("SqliteOutbox", () => {
    let db: sqlite.Database;
    let outbox: SqliteOutbox;

    beforeEach(async () => {
        db = await sqlite.open({
            filename: ":memory:",
            driver: require("sqlite3").Database,
        });
        outbox = new SqliteOutbox(db);

        return async () => {
            await db.close();
        };
    });

    async function isTableCreated(name: string): Promise<boolean> {
        const row = await db.get(
            "SELECT * FROM sqlite_master WHERE name = $1 AND type = 'table'",
            [name]
        );

        return !!row;
    }

    it.each([
        {
            description: "store()",
            operation: () => outbox.store(DummyMessage.create()),
        },
        {
            description: "getUnpublishedMessages()",
            operation: () => outbox.getUnpublishedMessages(),
        },
        {
            description: "markMessagesAsPublished()",
            operation: () => outbox.markMessagesAsPublished(0, 1),
        },
    ])(
        "creates a new table if it does not exist - $description",
        async ({ operation }) => {
            await expect(isTableCreated("outbox")).resolves.toBe(false);

            try {
                await operation();
            } catch {}

            await expect(isTableCreated("outbox")).resolves.toBe(true);
        }
    );

    function expectMessagesToEqual(a: Message[], b: Message[]): void {
        expect(a.map((m) => serialize(m))).toEqual(b.map((m) => serialize(m)));
    }

    function serialize(m: Message): Record<string, unknown> {
        return JSON.parse(JSON.stringify(m.serialize()));
    }

    test("store() - stores a message", async () => {
        const message = DummyMessage.create();

        await outbox.store(message);

        const row = await db.get("SELECT * FROM outbox WHERE message_id = $1", [
            message.getMessageId(),
        ]);
        expect(row.position).toBe(1);
        expect(JSON.parse(row.data)).toEqual(serialize(message));
    });

    test("position is auto-incremented", async () => {
        const message = DummyMessage.create();

        await outbox.store(message);
        await outbox.store(message);

        const [row1, row2] = await db.all("SELECT * FROM outbox");
        expect(row1.position).toBe(1);
        expect(row2.position).toBe(2);
    });

    test("getUnpublishedMessages() - when there are no unpublished messages", async () => {
        const [position, messages] = await outbox.getUnpublishedMessages();

        expect(position).toBe(0);
        expect(messages).toEqual([]);
    });

    test("getUnpublishedMessages() - returns unpublished messages", async () => {
        const messages = DummyMessage.createMany(5);
        for (const message of messages) {
            await outbox.store(message);
        }
        await db.run("UPDATE outbox SET published = TRUE WHERE position < 3");

        const [position, result] = await outbox.getUnpublishedMessages();
        expect(position).toBe(2);
        expectMessagesToEqual(result, messages.slice(2));
    });

    test("markMessagesAsPublished() - marks messages as published", async () => {
        const messages = DummyMessage.createMany(5);
        for (const message of messages) {
            await outbox.store(message);
        }

        await outbox.markMessagesAsPublished(0, 3);

        const result = await db.all(
            "SELECT published FROM outbox WHERE position > 0 LIMIT 3"
        );
        expect(result.length).toBe(3);
        expect(result.map((r) => r.published)).toEqual([1, 1, 1]);
    });
});
