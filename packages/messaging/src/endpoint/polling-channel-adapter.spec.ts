import { beforeEach, describe, expect, it, test, vi } from "vitest";
import _ from "lodash";
import { Message } from "@hexai/core";
import { waitForTicks } from "@hexai/core/test";

import { FooMessage } from "@/test-fixtures";
import { AbstractLifecycle } from "@/helpers";
import { MessageChannel } from "@/channel";
import { PollingChannelAdapter } from "./polling-channel-adapter";
import { MessageSourcePoller } from "./message-source-poller";
import { MessageSource } from "./message-source";

describe("PollingChannelAdapter", () => {
    let messageSource: MessageSourceStub;
    let poller: MessageSourcePoller;
    const outputChannel: MessageChannel = {
        send: vi.fn(),
    };
    let adapter: PollingChannelAdapter;

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.resetAllMocks();

        messageSource = new MessageSourceStub();
        messageSource.setReceiveFunction(() => null);
        poller = new ImmediatelyInvokingPoller();
        adapter = new PollingChannelAdapter(messageSource, poller, 1);
    });

    function withPoller(poller: MessageSourcePoller): void {
        adapter = new PollingChannelAdapter(messageSource, poller, 1);
    }

    function startAdapter(): Promise<void> {
        adapter.setOutputChannel(outputChannel);
        return adapter.start();
    }

    function expectNumberOfMessagesSentToBe(number: number): void {
        expect(outputChannel.send).toHaveBeenCalledTimes(number);
    }

    function expectMessageSentToBe(message: Message): void {
        expect(outputChannel.send).toHaveBeenCalledWith(message);
    }

    async function wait(time: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, time));
    }

    it("cannot start without an outbound channel", async () => {
        await expect(adapter.start()).rejects.toThrowError(
            /output channel required/
        );
    });

    it("initializes the message source on start", async () => {
        const spy = vi.spyOn(messageSource, "start");

        await startAdapter();

        expect(spy).toHaveBeenCalled();
    });

    it("starts the poller when the message source is initialized", async () => {
        const messageSourceStart = vi.spyOn(messageSource, "start");
        const pollerStart = vi.spyOn(poller, "start");
        messageSourceStart.mockImplementation(async () => {
            expect(pollerStart).not.toHaveBeenCalled();
        });

        await startAdapter();

        expect(pollerStart).toHaveBeenCalled();
    });

    it("cannot stop without starting", async () => {
        await expect(adapter.stop()).rejects.toThrowError(/not started/);
    });

    it("gracefully shuts down the poller", async () => {
        await startAdapter();
        vi.spyOn(poller, "stop").mockImplementation(async () => {
            await wait(100);
        });

        const beforeStop = Date.now();
        await adapter.stop();
        const afterStop = Date.now();

        expect(afterStop - beforeStop).toBeGreaterThanOrEqual(100);
    });

    it("stops the message source after the poller is stopped", async () => {
        await startAdapter();
        const messageSourceStop = vi.spyOn(messageSource, "stop");
        vi.spyOn(poller, "stop").mockImplementation(async () => {
            expect(messageSourceStop).not.toHaveBeenCalled();
        });

        await adapter.stop();

        expect(messageSourceStop).toHaveBeenCalled();
    });

    it("sends messages received from the message source", async () => {
        const message = FooMessage.create();
        messageSource.setReceiveFunction(() => message);

        await startAdapter();

        await waitForTicks();
        expectNumberOfMessagesSentToBe(1);
        expectMessageSentToBe(message);
    });

    it("ignores when message source returns null", async () => {
        messageSource.setReceiveFunction(() => null);

        await startAdapter();

        expectNumberOfMessagesSentToBe(0);
    });

    it("does not process messages when stopping", async () => {
        const timeUnit = 10;
        messageSource.setReceiveFunction(() => FooMessage.create());
        withPoller(new IntervalBasedPoller(timeUnit));

        await startAdapter();
        await wait(timeUnit * 2.5);
        // should have processed two messages by now
        await adapter.stop();

        // wait to see if any more messages are processed
        await wait(timeUnit * 5);
        expectNumberOfMessagesSentToBe(2);
    });

    test.each([1, 2, 3])(
        "max messages per poll",
        async (maxMessagesPerPoll) => {
            messageSource.setReceiveFunction(() => FooMessage.create());
            adapter.setMaxMessagesPerPoll(maxMessagesPerPoll);

            await startAdapter();

            await waitForTicks();
            expectNumberOfMessagesSentToBe(maxMessagesPerPoll);
        }
    );

    test.each([3, 5, 10])(
        "when max messages per poll is 0, polls until message source returns null",
        async (numMessagesInSource) => {
            const messages = [
                ..._.times(numMessagesInSource, FooMessage.create),
                null,
            ];
            messageSource.setReceiveFunction(() => messages.shift()!);
            adapter.setMaxMessagesPerPoll(0);

            await startAdapter();

            await waitForTicks();
            expectNumberOfMessagesSentToBe(numMessagesInSource);
        }
    );
});

class MessageSourceStub extends AbstractLifecycle implements MessageSource {
    protected override async onStart(): Promise<void> {}
    protected override async onStop(): Promise<void> {}

    private doReceive!: () => Message | null;

    public setReceiveFunction(fn: () => Message | null): void {
        this.doReceive = fn;
    }

    public async receive(): Promise<Message | null> {
        return this.doReceive();
    }
}

class ImmediatelyInvokingPoller
    extends AbstractLifecycle
    implements MessageSourcePoller
{
    private callback!: () => Promise<void>;

    protected override async onStart(): Promise<void> {
        await this.callback();
    }

    protected override async onStop(): Promise<void> {}

    public onPoll(callback: () => Promise<void>): void {
        this.callback = callback;
    }
}

class IntervalBasedPoller
    extends AbstractLifecycle
    implements MessageSourcePoller
{
    private callback!: () => Promise<void>;
    private intervalId!: NodeJS.Timeout;

    constructor(private interval: number) {
        super();
    }

    protected override async onStart(): Promise<void> {
        this.intervalId = setInterval(this.callback, this.interval);
    }

    protected override async onStop(): Promise<void> {
        clearInterval(this.intervalId);
    }

    public onPoll(callback: () => Promise<void>): void {
        this.callback = callback;
    }
}
