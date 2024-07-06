import { afterAll, beforeEach, describe, expect, it, test } from "vitest";
import { uuid } from "uuidv4";
import { Message } from "@hexai/core";
import { DummyMessage, expectMessagesToBeEqual } from "@hexai/core/test";
import {
    MessageChannel,
    PositionTracker,
    SqlitePositionTracker,
} from "@hexai/messaging";

import { EsdbHelper } from "@/esdb-helper";
import {
    ContextForEsdbPollingChannelAdapter,
    EsdbPollingChannelAdapter,
} from "@/esdb-polling-channel-adapter";
import { esdbClient } from "@/test-fixtures";

const esdb = new EsdbHelper(esdbClient);

function id(): string {
    return uuid().slice(0, 3);
}

interface RecordingOutputChannel extends MessageChannel {
    _appendMessage(message: Message): void;
    collectReceivedMessages(): Message[];
}

function createNaiveAdapter({
    stream,
    maxMessages,
}: {
    stream?: string;
    maxMessages?: number;
} = {}): EsdbPollingChannelAdapter {
    return new EsdbPollingChannelAdapter({
        id: id(),
        stream: stream ?? newStreamName(),
        maxMessages,
    });
}

function expectMessagesToFullyEqual(
    expectedMessages: Message[],
    messages: Message[]
): void {
    expectMessagesToBeEqual(messages, expectedMessages);

    expect(messages.map((m) => m.getMessageId())).toEqual(
        expectedMessages.map((m) => m.getMessageId())
    );
}

function createRecordingOutputChannel(): RecordingOutputChannel {
    let messages: Message[] = [];

    return {
        _appendMessage(message: Message) {
            messages.push(message);
        },
        async send(message: Message) {
            messages.push(message);
        },
        collectReceivedMessages() {
            const ret = messages;
            messages = [];
            return ret;
        },
    };
}

function newStreamName(): string {
    return `test__stream_polling_adapter_${id()}`;
}

describe("EsdbPollingChannelAdapter", () => {
    let positionTracker: PositionTracker;
    let adapter: EsdbPollingChannelAdapter;
    let receiver: RecordingOutputChannel;
    let stream: string;
    let adapters: EsdbPollingChannelAdapter[] = [];
    let streams: string[] = [];

    const messages = DummyMessage.createMany(10);
    const context: ContextForEsdbPollingChannelAdapter = {
        getEsdbClient() {
            return esdbClient;
        },
        getPositionTracker() {
            return positionTracker;
        },
    };

    async function setup(
        ...params: Parameters<typeof createNaiveAdapter>
    ): Promise<void> {
        positionTracker = new SqlitePositionTracker(":memory:");
        const env = createTestingEnvironment(...params);
        adapter = env.adapter;
        receiver = env.receiver;
        stream = env.stream;

        await esdb.publishToStream(stream, messages);
    }

    function createTestingEnvironment(
        ...params: Parameters<typeof createNaiveAdapter>
    ): {
        adapter: EsdbPollingChannelAdapter;
        receiver: RecordingOutputChannel;
        stream: string;
    } {
        const stream = newStreamName();
        const adapter = createNaiveAdapter({
            ...params[0],
            stream,
        });
        const receiver = createRecordingOutputChannel();

        adapter.setOutputChannel(receiver);
        adapter.setApplicationContext(context);

        adapters.push(adapter);
        streams.push(stream);

        return {
            adapter,
            receiver,
            stream,
        };
    }

    async function pollOnce(): Promise<void> {
        await adapter.start();
        await adapter.stop();
    }

    async function stopRunningAdapters(): Promise<void> {
        const runningAdapters = adapters.filter((a) => a.isRunning());
        await Promise.all(runningAdapters.map((a) => a.stop()));
    }

    async function deleteStreamsUsedInTest(): Promise<void> {
        await Promise.all(streams.map((s) => esdbClient.deleteStream(s)));
    }

    beforeEach(async () => {
        adapters = [];

        return async () => {
            await stopRunningAdapters();
            await deleteStreamsUsedInTest();
        };
    });

    afterAll(async () => {
        await esdbClient.dispose();
    });

    test("cannot start without output channel", async () => {
        await expect(createNaiveAdapter().start()).rejects.toThrowError(
            "no output channel set"
        );
    });

    test("cannot start without esdb client", async () => {
        const adapter = createNaiveAdapter();
        adapter.setOutputChannel(createRecordingOutputChannel());

        await expect(adapter.start()).rejects.toThrowError(
            "no application context set"
        );
    });

    test("initial poll", async () => {
        await setup();

        await adapter.start();

        expectMessagesToFullyEqual(
            messages,
            receiver.collectReceivedMessages()
        );
    });

    test("limiting number of messages", async () => {
        await setup({
            maxMessages: 5,
        });
        const target = messages.slice(0, 5);

        await adapter.start();

        expectMessagesToFullyEqual(target, receiver.collectReceivedMessages());
    });

    it("only consumes unprocessed messages", async () => {
        await setup({ maxMessages: 1 });

        await pollOnce();
        expectMessagesToFullyEqual(
            messages.slice(0, 1),
            receiver.collectReceivedMessages()
        );

        await pollOnce();
        expectMessagesToFullyEqual(
            messages.slice(1, 2),
            receiver.collectReceivedMessages()
        );

        await pollOnce();
        expectMessagesToFullyEqual(
            messages.slice(2, 3),
            receiver.collectReceivedMessages()
        );
    });

    async function recordAndFail(
        this: RecordingOutputChannel,
        message: Message
    ): Promise<void> {
        this._appendMessage(message);
        throw new Error("fail");
    }

    it("does not count as processed if not sent", async () => {
        await setup();
        receiver.send = recordAndFail;

        await expectOnlyTheFirstMessageToBeProcessed();
        await expectOnlyTheFirstMessageToBeProcessed();
    });

    async function expectOnlyTheFirstMessageToBeProcessed() {
        await pollOnce();
        expectMessagesToFullyEqual(
            messages.slice(0, 1),
            receiver.collectReceivedMessages()
        );
    }
});
