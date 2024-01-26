import { Message } from "@hexai/core";
import {
    DummyMessage,
    expectMessagesToEqual,
    setExpect,
    waitForMs,
} from "@hexai/core/test";
import { replaceDatabaseNameIn } from "@hexai/core/utils";
import { MessageChannel } from "@hexai/messaging";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { DB_URL } from "@/config";
import { PostgresOutbox } from "@/postgres-outbox";
import { PostgresUnitOfWork } from "@/postgres-unit-of-work";
import { createTestContext } from "@/test";
import { PostgresOutboxInboundChannelAdapter } from "./postgres-outbox-inbound-channel-adapter";
import { Client } from "pg";

setExpect(expect);

describe("PostgresOutboxInboundChannelAdapter", () => {
    const testContext = createTestContext(
        replaceDatabaseNameIn(DB_URL, "test_outbox_inbound_channel_adapter")
    );
    const client = testContext.client;
    const outbox = new PostgresOutbox(client);

    let adapter: PostgresOutboxInboundChannelAdapter;
    let outputChannel: MessageChannel & {
        messages: Message[];
        clear(): void;
    };

    let registeredClients: Client[];
    let registeredAdapters: PostgresOutboxInboundChannelAdapter[];

    const timeoutWithJitter = 200;

    beforeAll(async () => {
        await testContext.setup();

        return async () => {
            await testContext.teardown();
        };
    });

    beforeEach(async () => {
        await testContext.tableManager.truncateTable("hexai__outbox");

        registeredClients = [];
        registeredAdapters = [];
        outputChannel = createOutputChannel();
        adapter = createAdapter(outputChannel);

        return async () => {
            await Promise.all(
                registeredAdapters.map(async (a) => {
                    if (a.isRunning()) {
                        await a.stop();
                    }
                })
            );
            await Promise.all(registeredClients.map((c) => c.end()));
        };
    });

    function createOutputChannel(): MessageChannel & {
        messages: Message[];
        clear(): void;
    } {
        return {
            messages: [],
            async send(message) {
                this.messages.push(message);
            },
            clear() {
                this.messages = [];
            },
        };
    }

    function createAdapter(
        channel: MessageChannel
    ): PostgresOutboxInboundChannelAdapter {
        const channelAdapter = new PostgresOutboxInboundChannelAdapter();
        const client = createClient();
        channelAdapter.setApplicationContext({
            getUnitOfWork: () => new PostgresUnitOfWork(() => client),
        });
        channelAdapter.setOutputChannel(channel);
        registeredAdapters.push(channelAdapter);
        return channelAdapter;
    }

    function createClient(): Client {
        const client = testContext.newClient();
        registeredClients.push(client);
        return client;
    }

    async function storeMessagesInOutbox(messages: Message[]): Promise<void> {
        for (const message of messages) {
            await outbox.store(message);
        }
    }

    function expectMessagesDelivered(messages: Message[]): void {
        expectMessagesToEqual(outputChannel.messages, messages);
        outputChannel.clear();
    }

    test("when there is no message in the outbox", async () => {
        await adapter.start();

        expectMessagesDelivered([]);
    });

    test("delivering a single message in the outbox", async () => {
        const message = DummyMessage.create();
        await outbox.store(message);

        await adapter.start();

        expectMessagesDelivered([message]);
    });

    test("marks when output channel succeeds", async () => {
        const message = DummyMessage.create();
        await outbox.store(message);

        await adapter.start();

        const [_, unpublishedMessages] = await outbox.getUnpublishedMessages();
        expect(unpublishedMessages).toHaveLength(0);
    });

    test("does not mark when output channel fails", async () => {
        vi.spyOn(outputChannel, "send").mockImplementationOnce(() => {
            throw new Error("error!");
        });
        const message = DummyMessage.create();
        await outbox.store(message);

        await adapter.start();

        const [_, unpublishedMessages] = await outbox.getUnpublishedMessages();
        expectMessagesToEqual(unpublishedMessages, [message]);
    });

    test("delivering multiple messages in the outbox", async () => {
        const messages = DummyMessage.createMany(5);
        await storeMessagesInOutbox(messages);

        await adapter.start();

        expectMessagesDelivered(messages);
    });

    test("times out for configured amount of time, and resumes polling", async () => {
        const messages = DummyMessage.createMany(6);
        await adapter.start();

        await storeMessagesInOutbox(messages.slice(0, 2));
        await waitForMs(timeoutWithJitter);
        expectMessagesDelivered(messages.slice(0, 2));

        await storeMessagesInOutbox(messages.slice(2, 4));
        await waitForMs(timeoutWithJitter);
        expectMessagesDelivered(messages.slice(2, 4));

        await adapter.stop();
        await waitForMs(timeoutWithJitter);
        expectMessagesToEqual([], outputChannel.messages);
    });

    test("locking", async () => {
        const anotherOutputChannel = createOutputChannel();
        await storeMessagesInOutbox(DummyMessage.createMany(5));

        const anotherAdapter = createAdapter(anotherOutputChannel);

        await Promise.all([adapter.start(), anotherAdapter.start()]);

        if (outputChannel.messages.length > 0) {
            expect(anotherOutputChannel.messages).toHaveLength(0);
            expect(outputChannel.messages).toHaveLength(5);
            outputChannel.clear();

            await storeMessagesInOutbox(DummyMessage.createMany(5));
            await waitForMs(timeoutWithJitter * 2);

            expect(anotherOutputChannel.messages).toHaveLength(0);
            expect(outputChannel.messages).toHaveLength(5);
        } else {
            expect(outputChannel.messages).toHaveLength(0);
            expect(anotherOutputChannel.messages).toHaveLength(5);
            anotherOutputChannel.clear();

            await storeMessagesInOutbox(DummyMessage.createMany(5));
            await waitForMs(timeoutWithJitter * 2);

            expect(outputChannel.messages).toHaveLength(0);
            expect(anotherOutputChannel.messages).toHaveLength(5);
        }
    });
});
