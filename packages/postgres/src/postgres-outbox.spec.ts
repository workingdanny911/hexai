import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { Message } from "@hexai/core";
import { replaceDatabaseNameIn } from "@hexai/core/utils";
import { DummyMessage } from "@hexai/core/test";

import { createTestContext } from "@/test";
import { DB_URL } from "@/config";
import { PostgresOutbox } from "@/postgres-outbox";

describe("PostgresOutbox", () => {
    const testContext = createTestContext(
        replaceDatabaseNameIn(DB_URL, "test_outbox")
    );
    const client = testContext.client;
    const outbox = new PostgresOutbox(client);

    beforeAll(async () => {
        await testContext.setup();

        return async () => {
            await testContext.teardown();
        };
    });

    beforeEach(async () => {
        await testContext.tableManager.truncateTable("hexai__outbox");
    });

    test("when there are no unpublished messages", async () => {
        const [position, messages] = await outbox.getUnpublishedMessages();

        expect(position).toBe(0);
        expect(messages).toEqual([]);
    });

    test("fetching unpublished messages", async () => {
        const message = DummyMessage.create();
        await client.query("INSERT INTO hexai__outbox (message) VALUES ($1)", [
            message.serialize(),
        ]);

        const [position, messages] = await outbox.getUnpublishedMessages();
        expect(position).toBe(1);
        expect(messages).toEqual([message.asType(Message)]);
    });

    test("storing a message", async () => {
        const message = DummyMessage.create();

        await outbox.store(message);

        const [position, messages] = await outbox.getUnpublishedMessages();
        expect(position).toBe(1);
        expect(messages).toEqual([message.asType(Message)]);
    });

    test("storing multiple messages", async () => {
        const messages = DummyMessage.createMany(3);

        await Promise.all(messages.map((message) => outbox.store(message)));

        const [position, storedMessages] =
            await outbox.getUnpublishedMessages();
        expect(position).toBe(1);
        expect(storedMessages).toEqual(
            messages.map((message) => message.asType(Message))
        );
    });

    test("marking messages as published", async () => {
        const messages = DummyMessage.createMany(3);

        await Promise.all(messages.map((message) => outbox.store(message)));

        await outbox.markMessagesAsPublished(1, 2);

        const [position, storedMessages] =
            await outbox.getUnpublishedMessages();
        expect(position).toBe(3);
        expect(storedMessages).toEqual([messages[2].asType(Message)]);
    });
});
