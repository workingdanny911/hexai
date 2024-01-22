import {
    beforeEach,
    describe,
    expect,
    it,
    SpyInstance,
    test,
    vi,
} from "vitest";
import { MessageChannel } from "@hexai/messaging";
import { Message } from "@hexai/core";
import { DummyMessage, waitForMs } from "@hexai/core/test";
import {
    PersistentSubscriptionDoesNotExistError,
    persistentSubscriptionToStreamSettingsFromDefaults,
} from "@eventstore/db-client";

import { esdbClient } from "@/test-fixtures";
import { EsdbHelper } from "@/esdb-helper";
import { EsdbInboundChannelAdapter } from "./esdb-inbound-channel-adapter";

const STREAM = "test-stream";
const GROUP = "test-group";

describe("ESDBInboundChannelAdapter", () => {
    let defaultAdapter: EsdbInboundChannelAdapter;
    let outputChannel: MessageChannel & {
        messages: Message[];
    };

    beforeEach(async () => {
        vi.resetAllMocks();
        vi.restoreAllMocks();
        await esdbClient.deleteStream(STREAM);
        await deleteConsumerGroup();

        outputChannel = {
            messages: [],
            async send(message: Message): Promise<void> {
                this.messages.push(message);
            },
        };

        defaultAdapter = makeAdapter();
        defaultAdapter.setOutputChannel(outputChannel);
    });

    test("cannot start if no output channel is set", async () => {
        await expect(makeAdapter().start()).rejects.toThrow(
            "output channel required"
        );
    });

    it("creates consumer group upon start", async () => {
        await expect(getConsumerGroupInfo()).rejects.toThrowError(
            PersistentSubscriptionDoesNotExistError
        );

        await defaultAdapter.start();

        const info = await getConsumerGroupInfo();
        expect(info.status).toBe("Live");
    });

    test("default settings", async () => {
        await defaultAdapter.start();

        const info = await getConsumerGroupInfo();
        expect(info.settings).toContain({
            maxRetryCount: 10,
            messageTimeout: 30000,
            startFrom: "start",
        });
    });

    test("when consumer group is already created", async () => {
        await createConsumerGroup();

        // should not throw
        await defaultAdapter.start();
    });

    test("consuming", async () => {
        const events = DummyMessage.createMany(10);
        await publishEvents(events);

        await defaultAdapter.start();

        await waitForMs(100);
        expect(events).toEqual(outputChannel.messages);
    });

    it("acks when message is sent to output channel successfully", async () => {
        const spy = spySubscription();
        const event = DummyMessage.create();
        await publishEvents([event]);

        await defaultAdapter.start();

        await waitForMs(100);
        const acked = spy.ack.mock.calls[0][0];
        expect(acked.event.id).toBe(event.getMessageId());
        expect(spy.nack).not.toHaveBeenCalled();
    });

    it("nacks when message is not sent to output channel successfully", async () => {
        const spy = spySubscription();
        const event = DummyMessage.create();
        await publishEvents([event]);

        outputChannel.send = async () => {
            // do not send actual nack, because it will cause retries
            spy.nack.mockImplementation(async () => {
                return;
            });
            throw new Error("error");
        };

        await defaultAdapter.start();

        await waitForMs(100);
        const nacked = spy.nack.mock.calls[0][2];
        expect(nacked.event.id).toBe(event.getMessageId());
        expect(spy.ack).not.toHaveBeenCalled();
    });

    it("unsubscribes upon stop", async () => {
        await defaultAdapter.start();

        await defaultAdapter.stop();

        await waitForMs(100);
        const info = await getConsumerGroupInfo();
        expect(info.connections).toHaveLength(0);
    });
});

function makeAdapter() {
    return new EsdbInboundChannelAdapter(esdbClient, {
        stream: STREAM,
        group: GROUP,
    });
}

async function createConsumerGroup(): Promise<void> {
    await esdbClient.createPersistentSubscriptionToStream(
        STREAM,
        GROUP,
        persistentSubscriptionToStreamSettingsFromDefaults()
    );
}

async function publishEvents(events: Message[]): Promise<void> {
    await new EsdbHelper(esdbClient).publishToStream(STREAM, events);
}

async function getConsumerGroupInfo() {
    return await esdbClient.getPersistentSubscriptionToStreamInfo(
        STREAM,
        GROUP
    );
}

async function deleteConsumerGroup() {
    try {
        await esdbClient.deletePersistentSubscriptionToStream(STREAM, GROUP);
    } catch (e) {
        if (e instanceof PersistentSubscriptionDoesNotExistError) {
            // ignore
        } else {
            throw e;
        }
    }
}

function spySubscription() {
    const ret: Record<string, SpyInstance> = {};

    const orig = esdbClient.subscribeToPersistentSubscriptionToStream;
    vi.spyOn(
        esdbClient,
        "subscribeToPersistentSubscriptionToStream"
    ).mockImplementation((stream: string, group: string) => {
        const subscription = orig.call(esdbClient, stream, group);

        ret["ack"] = vi.spyOn(subscription, "ack");
        ret["nack"] = vi.spyOn(subscription, "nack");

        return subscription;
    });

    return ret;
}
