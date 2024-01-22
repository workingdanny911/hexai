import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Message } from "@hexai/core";
import {
    AbstractInboundChannelAdapter,
    MessageChannel,
} from "@hexai/messaging";

import { PostgresUnitOfWork } from "@/postgres-unit-of-work";
import { createTestContext } from "@/test";
import { replaceDatabaseNameIn } from "@hexai/core/utils";
import { DB_URL } from "@/config";

class PostgresOutboxInboundChannelAdapter extends AbstractInboundChannelAdapter {
    private static lockName = "outbox_poller";

    private lockAcquired = false;

    constructor(private uow: PostgresUnitOfWork) {
        super();
    }

    protected async onStart(): Promise<void> {
        await super.onStart();
        await this.uow.wrap(async (client) => {
            const result = await client.query(
                "INSERT INTO hexai__locks (name) VALUES ($1)",
                [PostgresOutboxInboundChannelAdapter.lockName]
            );

            this.lockAcquired = result.rowCount !== 0;
        });
    }

    protected receiveMessage(): Promise<Message<
        Record<string, unknown>
    > | null> {
        throw new Error("Method not implemented.");
    }
}

describe("PostgresOutboxInboundChannelAdapter", () => {
    const testContext = createTestContext(
        replaceDatabaseNameIn(DB_URL, "test_outbox_inbound_channel_adapter")
    );
    const client = testContext.client;
    const lockName = (PostgresOutboxInboundChannelAdapter as any).lockName;
    let adapter: PostgresOutboxInboundChannelAdapter;
    let outputChannel: MessageChannel & {
        messages: Message[];
    };

    beforeAll(async () => {
        await testContext.setup();

        return async () => {
            await testContext.teardown();
        };
    });

    beforeEach(async () => {
        await testContext.tableManager.truncateTable("hexai__outbox");
        await testContext.tableManager.truncateTable("hexai__locks");

        outputChannel = {
            messages: [],
            async send(message) {
                this.messages.push(message);
            },
        };
        adapter = new PostgresOutboxInboundChannelAdapter(
            new PostgresUnitOfWork(() => client)
        );
        adapter.setOutputChannel(outputChannel);
    });

    async function hasLock() {
        const result = await client.query(
            "SELECT * FROM hexai__locks WHERE name = $1",
            [lockName]
        );
        return result.rowCount === 1;
    }

    it("tries to acquire lock upon start", async () => {
        expect(await hasLock()).toBe(false);

        await adapter.start();

        expect(await hasLock()).toBe(true);
    });
});
