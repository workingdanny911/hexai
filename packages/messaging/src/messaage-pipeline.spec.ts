import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { Message } from "@hexai/core/message";
import { waitForSeveralTicks } from "@hexai/core/test";

import {
    DirectChannel,
    MessageChannel,
    PollableMessageChannel,
    SubscribableMessageChannel,
} from "@/channel";
import { BarMessage, BazMessage, FooMessage } from "@/test-fixtures";
import { AbstractInboundChannelAdapter } from "@/endpoint";
import { MessageFlow } from "@/message-pipeline";

const outputChannel: MessageChannel = {
    send: vi.fn(),
};

beforeEach(() => {
    vi.resetAllMocks();
});

function expectMessagesSentToBe(messages: Message[]): void {
    expect(outputChannel.send).toHaveBeenCalledTimes(messages.length);
    for (let i = 0; i < messages.length; i++) {
        expect(outputChannel.send).toHaveBeenNthCalledWith(i + 1, messages[i]);
    }
}

describe("channel A->B", () => {
    let inputChannel: SubscribableMessageChannel;
    const message = FooMessage.create();

    beforeEach(() => {
        inputChannel = new DirectChannel();
    });

    test("cannot set output channel twice", () => {
        const build = () =>
            MessageFlow.from(inputChannel).to(outputChannel).to(outputChannel);

        expect(build).toThrowError("output channel already set");
    });

    test("cannot settle if input channel is not subscribable", () => {
        const pollableChannel: PollableMessageChannel = {
            send: async () => true,
            receive: async () => message,
        };
        const settle = () =>
            // @ts-expect-error
            MessageFlow.from(pollableChannel).to(outputChannel).settle();

        expect(settle).toThrowError("is not a subscribable");
    });

    it("does not connect the channels until the flow is started", async () => {
        const flow = MessageFlow.from(inputChannel).to(outputChannel).settle();

        await expect(inputChannel.send(message)).rejects.toThrowError(
            "no subscriber"
        );

        await flow.start();
        await inputChannel.send(message);
        expect(outputChannel.send).toHaveBeenCalledWith(message);
    });

    test("channel A->B", async () => {
        await MessageFlow.from(inputChannel).to(outputChannel).settle().start();

        await inputChannel.send(message);
        expectMessagesSentToBe([message]);
    });
});

describe("with filters & transformers", () => {
    let inputChannel: SubscribableMessageChannel;
    const message = FooMessage.create();

    beforeEach(() => {
        inputChannel = new DirectChannel();
    });

    test("with single filter - accept", async () => {
        await MessageFlow.from(inputChannel)
            .filter(() => true)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([message]);
    });

    test("with single filter - reject", async () => {
        await MessageFlow.from(inputChannel)
            .filter(() => false)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([]);
    });

    test("with multiple filters", async () => {
        await MessageFlow.from(inputChannel)
            .filter(() => true)
            .filter(() => false)
            .filter(() => true)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([]);
    });

    test("with single transformer", async () => {
        const transformedMessage = BarMessage.create();

        await MessageFlow.from(inputChannel)
            .transform((message) => {
                expect(message.getMessageType()).toBe(FooMessage.type);

                return transformedMessage;
            })
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([transformedMessage]);
    });

    test("with multiple transformers", async () => {
        const finalMessage = BazMessage.create();

        await MessageFlow.from(inputChannel)
            .transform(() => BarMessage.create())
            .transform((message) => {
                expect(message.getMessageType()).toBe(BarMessage.type);

                return finalMessage;
            })
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([finalMessage]);
    });

    test("applied in order", async () => {
        const barMessage = BarMessage.create();

        await MessageFlow.from(inputChannel)
            .filter((message) => message.getMessageType() === FooMessage.type)
            .transform(() => barMessage)
            .filter((message) => message.getMessageType() === BarMessage.type)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(message);
        expectMessagesSentToBe([barMessage]);
    });
});

class InboundChannelAdapterStub extends AbstractInboundChannelAdapter {
    private messages: Message[];

    constructor(messages: Message[]) {
        super();
        this.messages = [...messages];
    }

    async start(): Promise<void> {
        await super.start();

        while (await this.processMessage()) {}
    }

    protected async receiveMessage(): Promise<Message | null> {
        return this.messages.shift() ?? null;
    }
}

describe("with inbound channel adapter", () => {
    it("starts the adapter when the flow is started", async () => {
        const adapter = new InboundChannelAdapterStub([]);
        const spy = vi.spyOn(adapter, "start");

        const flow = MessageFlow.from(adapter).to(outputChannel).settle();
        expect(spy).not.toHaveBeenCalled();
        await flow.start();
        expect(spy).toHaveBeenCalled();
    });

    test("adapter -> channel A", async () => {
        const messages = [FooMessage.create(), BarMessage.create()];

        await MessageFlow.from(new InboundChannelAdapterStub(messages))
            .to(outputChannel)
            .settle()
            .start();

        await waitForSeveralTicks();
        expectMessagesSentToBe(messages);
    });
});

describe("with message handler", () => {
    let inputChannel: SubscribableMessageChannel;

    beforeEach(() => {
        inputChannel = new DirectChannel();
    });

    test("channel A->handler", async () => {
        const message = FooMessage.create();
        const handler = vi.fn();

        await MessageFlow.from(inputChannel).handle(handler).settle().start();

        await inputChannel.send(message);
        expect(handler).toHaveBeenCalledWith(message);
    });

    test("return value is piped to the output channel", async () => {
        const messageBeforeHandler = FooMessage.create();
        const messageAfterHandler = BarMessage.create();

        await MessageFlow.from(inputChannel)
            .handle(async () => messageAfterHandler)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(messageBeforeHandler);
        expectMessagesSentToBe([messageAfterHandler]);
    });

    test("message filter after handler", async () => {
        const messageBeforeHandler = FooMessage.create();
        const messageAfterHandler = BarMessage.create();

        await MessageFlow.from(inputChannel)
            .handle(async () => messageAfterHandler)
            .filter(() => false)
            .to(outputChannel)
            .settle()
            .start();

        await inputChannel.send(messageBeforeHandler);
        expectMessagesSentToBe([]);
    });
});

describe.todo("branching, routing messages", () => {
    /* channel A->B if message type is "test"
                ->C if message type is "test2" */
    // builder
    //     .from(A)
    //     .configureRoute('->B')
    //         .filter((message) => message.type === "test")
    //         .to(B)
    //     .configureRoute('->C')
    //         .filter((message) => message.type === "test2")
    //         .to(C)
    //     .route((message) => {
    //         if (message.type === "test") {
    //             return "->B";
    //         } else if (message.type === "test2") {
    //             return "->C";
    //         }
    //     })
    //     .build();
});

describe.todo("wiretapping", () => {
    /* wiretap */
    // builder.from(A).wiretap((message) => console.log(message)).to(B).build();
    //     .from(A)
    //     .wiretap((message) => console.log('any', message))
    //     .branch('->B')
    //         .wiretap((message) => console.log('B', message))
    //         .to(B)
    //     .branch('->C')
    //         .wiretap((message) => console.log('C', message))
    //         .to(C)
    //     .route((message) => {
    //         if (message.type === "test") {
    //             return "->B";
    //         } else if (message.type === "test2") {
    //             return "->C";
    //         }
    //     })
    //     .build();
});

describe.todo("observability");
