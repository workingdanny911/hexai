import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { Message } from "@hexai/core";
import {
    DummyMessage,
    expectMessagesToBeFullyEqual,
    getSqliteConnection,
    SqliteUnitOfWork,
} from "@hexai/core/test";

import { SqliteOutbox } from "./sqlite-outbox";

describe("SqliteOutbox", () => {
    let outbox: SqliteOutbox;

    beforeEach(async () => {
        outbox = new SqliteOutbox(
            new SqliteUnitOfWork(await getSqliteConnection())
        );
    });

    test("fetching unpublished messages - when no messages stored", async () => {
        const [position, messages] = await outbox.getUnpublishedMessages();

        expect(position).toBe(0);
        expect(messages).toEqual([]);
    });

    test("storing and fetching a single message", async () => {
        const message = DummyMessage.create();

        await outbox.store(message);

        const [position, result] = await outbox.getUnpublishedMessages();
        expect(position).toBe(0);
        expectMessagesToBeFullyEqual(result, [message]);
    });

    test("storing and fetching multiple messages", async () => {
        const messages = DummyMessage.createMany(5);

        await outbox.store(...messages);

        const [position, result] = await outbox.getUnpublishedMessages();
        expect(position).toBe(0);
        expectMessagesToBeFullyEqual(result, messages);
    });

    test("marking a single message as published", async () => {
        const message = DummyMessage.create();
        await storeMessages(message);

        await outbox.markMessagesAsPublished(0, 1);

        const [position, result] = await outbox.getUnpublishedMessages();
        expect(position).toBe(1);
        expect(result).toEqual([]);
    });

    async function storeMessages(...messages: Message[]): Promise<void> {
        for (const message of messages) {
            await outbox.store(message);
        }
    }

    test("storing multiple messages is transactional", async () => {
        const messages = DummyMessage.createMany(5);
        messages[4].getMessageId = () => {
            throw new Error("Simulated error");
        };

        await expect(outbox.store(...messages)).rejects.toThrow();

        const [position, result] = await outbox.getUnpublishedMessages();
        expect(position).toBe(0);
        expect(result).toEqual([]);
    });

    test("in action", async () => {
        const messages = DummyMessage.createMany(5);
        await outbox.store(...messages);

        for (let i = 0; i < messages.length; i++) {
            await outbox.markMessagesAsPublished(i, 1);

            const [fromPosition, unpublishedMessages] =
                await outbox.getUnpublishedMessages();
            expect(fromPosition).toBe(i + 1);
            expectMessagesToBeFullyEqual(
                unpublishedMessages,
                messages.slice(fromPosition)
            );
        }
    });
});
