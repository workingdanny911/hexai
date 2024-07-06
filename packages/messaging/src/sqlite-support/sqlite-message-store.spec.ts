import { Message } from "@hexai/core";
import {
    DummyMessage,
    expectMessagesToBeFullyEqual,
    getSqliteConnection,
    SqliteUnitOfWork,
} from "@hexai/core/test";
import { Database } from "sqlite";
import { beforeEach, describe, expect, test } from "vitest";
import { SqliteMessageStore } from "./sqlite-message-store";

describe("SqliteMessageStore", () => {
    let connection: Database;
    let messageStore: SqliteMessageStore;
    const messages = DummyMessage.createMany(10);

    beforeEach(async () => {
        connection = await getSqliteConnection();
        messageStore = new SqliteMessageStore(new SqliteUnitOfWork(connection));

        return () => connection.close();
    });

    function store(...messages: Message[]): Promise<void>;
    function store(key: string, ...messages: Message[]): Promise<void>;
    function store(...keyOrMessages: Array<string | Message>): Promise<void> {
        if (typeof keyOrMessages[0] === "string") {
            const [key, ...messages] = keyOrMessages;
            return messageStore.store(key, messages as Message[]);
        } else {
            return messageStore.store("key", keyOrMessages as Message[]);
        }
    }
    test("storing duplicate message, throws error", async () => {
        await store(messages[0]);

        const insertDuplicate = async () => {
            await store(messages[0]);
        };
        await expect(insertDuplicate).rejects.toThrow(/unique/i);
    });

    test("inserting messages is transactional", async () => {
        try {
            await store(...messages, messages[0]);
        } catch {
            // ignore
        }

        const storedMessages = await messageStore.get("key");
        expect(storedMessages).toHaveLength(0);
    });

    test("storing and getting messages, returns messages from db", async () => {
        await store(...messages);

        const loadedMessages = await messageStore.get("key");
        expectMessagesToBeFullyEqual(loadedMessages, messages);
    });

    test("getting messages when no messages are stored, returns empty array", async () => {
        const loadedMessages = await messageStore.get("key");
        expect(loadedMessages).toHaveLength(0);
    });

    test("getting messages from specific position, returns messages from that position", async () => {
        await store(...messages);

        const loadedMessages = await messageStore.get("key", 5);
        expectMessagesToBeFullyEqual(loadedMessages, messages.slice(5));
    });

    test("getting messages with batch size, returns messages with that batch size", async () => {
        await store(...messages);

        const loadedMessages = await messageStore.get("key", 0, 5);
        expectMessagesToBeFullyEqual(loadedMessages, messages.slice(0, 5));
    });
});
