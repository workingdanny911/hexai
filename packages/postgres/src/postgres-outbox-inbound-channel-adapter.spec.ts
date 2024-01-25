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

    beforeAll(async () => {
        await testContext.setup();

        return async () => {
            await testContext.teardown();
        };
    });

    beforeEach(async () => {
        await testContext.tableManager.truncateTable("hexai__outbox");

        outputChannel = {
            messages: [],
            async send(message) {
                this.messages.push(message);
            },
            clear() {
                this.messages = [];
            },
        };
        adapter = new PostgresOutboxInboundChannelAdapter();
        adapter.setApplicationContext({
            getUnitOfWork: () => new PostgresUnitOfWork(() => client),
        });
        adapter.setOutputChannel(outputChannel);

        return async () => {
            if (adapter.isRunning()) {
                await adapter.stop();
            }
        };
    });

    test("when there is no message in the outbox", async () => {
        await adapter.start();

        expectMessagesToEqual([], outputChannel.messages);
    });

    test("delivering a single message in the outbox", async () => {
        const message = DummyMessage.create();
        await outbox.store(message);

        await adapter.start();

        expectMessagesToEqual([message], outputChannel.messages);
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

        expectMessagesToEqual(messages, outputChannel.messages);
    });

    async function storeMessagesInOutbox(messages: Message[]): Promise<void> {
        for (const message of messages) {
            await outbox.store(message);
        }
    }

    function expectMessagesDelivered(messages: Message[]): void {
        expectMessagesToEqual(messages, outputChannel.messages);
        outputChannel.clear();
    }

    test("times out for configured amount of time, and resumes polling", async () => {
        const timeout = 100;
        const jitter = 10;
        const messages = DummyMessage.createMany(6);
        await adapter.start();

        await storeMessagesInOutbox(messages.slice(0, 2));
        await waitForMs(timeout + jitter);
        expectMessagesDelivered(messages.slice(0, 2));

        await storeMessagesInOutbox(messages.slice(2, 4));
        await waitForMs(timeout + jitter);
        expectMessagesDelivered(messages.slice(2, 4));

        await adapter.stop();
        await waitForMs(timeout + jitter);
        expectMessagesToEqual([], outputChannel.messages);
    });
});
