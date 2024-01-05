import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { Message } from "@hexai/core/message";
import { waitForSeveralTicks } from "@hexai/core/test";
import { ApplicationContextAware } from "@hexai/core/injection";
import { BaseApplicationContext } from "@hexai/core/application";

import {
    DirectChannel,
    MessageChannel,
    PollableMessageChannel,
    SubscribableMessageChannel,
} from "@/channel";
import { BarMessage, BazMessage, FooMessage } from "@/test-fixtures";
import { AbstractInboundChannelAdapter, MessageHandler } from "@/endpoint";
import {
    MessageHandlingContext,
    MessagePipeline,
    MessagePipelinesNamespace,
} from "@/message-pipeline";

let defaultInputChannel: SubscribableMessageChannel;
const defaultOutputChannel: MessageChannel = {
    send: vi.fn(),
};
const dummyApplicationContext: BaseApplicationContext = {
    getUnitOfWork: vi.fn(),
    getOutboxEventPublisher: vi.fn(),
};
let testNamespace: MessagePipelinesNamespace;

beforeEach(async () => {
    MessagePipelinesNamespace.clearRegistry();
    testNamespace = new MessagePipelinesNamespace("test-namespace");
    testNamespace.setApplicationContext(dummyApplicationContext);

    defaultInputChannel = new DirectChannel();
    vi.resetAllMocks();
    vi.restoreAllMocks();
});

function expectMessagesSentToBe(messages: Message[]): void {
    expect(defaultOutputChannel.send).toHaveBeenCalledTimes(messages.length);
    for (let i = 0; i < messages.length; i++) {
        expect(defaultOutputChannel.send).toHaveBeenNthCalledWith(
            i + 1,
            messages[i]
        );
    }
}

describe("namespace & initialization", () => {
    const invalidNames = [undefined, null, 1, {}, [], () => {}, ""];

    test.each(invalidNames)(
        "namespace should be non-empty string",
        (invalidName) => {
            expect(
                // @ts-expect-error
                () => new MessagePipelinesNamespace(invalidName)
            ).toThrowError("namespace must be a non-empty string");
        }
    );

    test("namespace cannot be duplicated", () => {
        new MessagePipelinesNamespace("duplicate");
        expect(() => new MessagePipelinesNamespace("duplicate")).toThrowError(
            "already defined"
        );
    });

    test.each(invalidNames)(
        "cannot create pipeline with invalid name",
        (invalidName) => {
            // @ts-expect-error
            expect(() => testNamespace.define(invalidName)).toThrowError(
                "name must be a non-empty string"
            );
        }
    );

    test("cannot define pipeline if name is already taken", () => {
        testNamespace
            .define("duplicate")
            .from(defaultInputChannel)
            .to(defaultOutputChannel)
            .settle();

        expect(() => testNamespace.define("duplicate")).toThrowError(
            "already defined"
        );
    });

    test("can use the same name in different namespaces", () => {
        testNamespace
            .define("duplicate")
            .from(defaultInputChannel)
            .to(defaultOutputChannel)
            .settle();

        expect(() =>
            new MessagePipelinesNamespace("another-namespace")
                .define("duplicate")
                .from(defaultInputChannel)
                .to(defaultOutputChannel)
                .settle()
        ).not.toThrowError();
    });

    test("cannot settle if no input channel", () => {
        const settle = () =>
            testNamespace
                .define("pipeline-for-test")
                // @ts-expect-error
                .to(defaultOutputChannel)
                .settle();

        expect(settle).toThrowError("no input channel");
    });

    test("cannot set output channel twice", () => {
        const settle = () =>
            testNamespace
                .define("pipeline-for-test")
                .from(defaultInputChannel)
                .to(defaultOutputChannel)
                .to(defaultOutputChannel);

        expect(settle).toThrowError("output channel already set");
    });

    test("cannot settle if input channel is not subscribable", () => {
        const pollableChannel: PollableMessageChannel = {
            send: async () => true,
            receive: async () => FooMessage.create(),
        };

        const settle = () =>
            testNamespace
                .define("pipeline-for-test")
                // @ts-expect-error
                .from(pollableChannel)
                .to(defaultOutputChannel)
                .settle();

        expect(settle).toThrowError("is not a subscribable");
    });

    test("cannot start if not settled", async () => {
        const pipeline = testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .to(defaultOutputChannel);

        // @ts-expect-error
        await expect(pipeline.start()).rejects.toThrowError("not settled");
    });

    test("stopping", async () => {
        const pipeline = testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .to(defaultOutputChannel)
            .settle();

        await pipeline.start();
        await pipeline.stop();

        await defaultInputChannel.send(FooMessage.create());
        expect(defaultOutputChannel.send).not.toHaveBeenCalled();
    });

    test("namespace cannot be started when application context is not set", async () => {
        const namespace = new MessagePipelinesNamespace("new");
        namespace.define("pipeline").from(defaultInputChannel).settle();

        await expect(namespace.start()).rejects.toThrowError(
            "Injecting object is not set"
        );
    });

    test("can be started and stopped at once", async () => {
        const inputChannel1 = new DirectChannel();
        const message1 = FooMessage.create();
        const pipeline1 = testNamespace
            .define("pipeline1")
            .from(inputChannel1)
            .to(defaultOutputChannel)
            .settle();

        const inputChannel2 = new DirectChannel();
        const message2 = BarMessage.create();
        const pipeline2 = testNamespace
            .define("pipeline2")
            .from(inputChannel2)
            .to(defaultOutputChannel)
            .settle();

        await testNamespace.start();

        expect(pipeline1.isRunning()).toBe(true);
        await inputChannel1.send(message1);
        expectMessagesSentToBe([message1]);

        expect(pipeline2.isRunning()).toBe(true);
        await inputChannel2.send(message2);
        expectMessagesSentToBe([message1, message2]);

        await testNamespace.stop();

        vi.resetAllMocks();
        expect(pipeline1.isRunning()).toBe(false);
        await inputChannel1.send(message1);
        expect(defaultOutputChannel.send).not.toHaveBeenCalled();

        expect(pipeline2.isRunning()).toBe(false);
        await inputChannel2.send(message2);
        expect(defaultOutputChannel.send).not.toHaveBeenCalled();
    });
});

describe("channel A->B", () => {
    const message = FooMessage.create();

    it("does not connect the channels until the pipeline is started", async () => {
        const pipeline = testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .to(defaultOutputChannel)
            .settle();

        await expect(defaultInputChannel.send(message)).rejects.toThrowError(
            "no subscriber"
        );

        await pipeline.start();
        await defaultInputChannel.send(message);
        expect(defaultOutputChannel.send).toHaveBeenCalledWith(message);
    });

    test("channel A->B", async () => {
        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([message]);
    });
});

describe("with filters & transformers", () => {
    const message = FooMessage.create();

    test("with single filter - accept", async () => {
        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .filter(() => true)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([message]);
    });

    test("with single filter - reject", async () => {
        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .filter(() => false)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([]);
    });

    test("with multiple filters", async () => {
        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .filter(() => true)
            .filter(() => false)
            .filter(() => true)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([]);
    });

    test("with single transformer", async () => {
        const transformedMessage = BarMessage.create();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .transform((message) => {
                expect(message.getMessageType()).toBe(FooMessage.type);

                return transformedMessage;
            })
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([transformedMessage]);
    });

    test("with multiple transformers", async () => {
        const finalMessage = BazMessage.create();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .transform(() => BarMessage.create())
            .transform((message) => {
                expect(message.getMessageType()).toBe(BarMessage.type);

                return finalMessage;
            })
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([finalMessage]);
    });

    test("applied in order", async () => {
        const barMessage = BarMessage.create();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .filter((message) => message.getMessageType() === FooMessage.type)
            .transform(() => barMessage)
            .filter((message) => message.getMessageType() === BarMessage.type)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expectMessagesSentToBe([barMessage]);
    });
});

class InboundChannelAdapterStub extends AbstractInboundChannelAdapter {
    private messages: Message[];

    constructor(messages: Message[]) {
        super();
        this.messages = [...messages];
    }

    protected override async onStart(): Promise<void> {
        while (await this.processMessage()) {}
    }

    protected override async onStop(): Promise<void> {}

    protected async receiveMessage(): Promise<Message | null> {
        return this.messages.shift() ?? null;
    }
}

describe("with inbound channel adapter", () => {
    it("starts the adapter when the pipeline is started", async () => {
        const adapter = new InboundChannelAdapterStub([]);
        const spy = vi.spyOn(adapter, "start");

        const pipeline = testNamespace
            .define("pipeline-for-test")
            .from(adapter)
            .to(defaultOutputChannel)
            .settle();
        expect(spy).not.toHaveBeenCalled();
        await pipeline.start();
        expect(spy).toHaveBeenCalled();
    });

    test("adapter -> channel A", async () => {
        const messages = [FooMessage.create(), BarMessage.create()];

        await testNamespace
            .define("pipeline-for-test")
            .from(new InboundChannelAdapterStub(messages))
            .to(defaultOutputChannel)
            .settle()
            .start();

        await waitForSeveralTicks();
        expectMessagesSentToBe(messages);
    });
});

describe("with message handler", () => {
    test("channel A->handler", async () => {
        const message = FooMessage.create();
        const handler = vi.fn();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(handler)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expect(handler).toHaveBeenCalledWith(message);
    });

    test("return value is piped to the output channel", async () => {
        const messageBeforeHandler = FooMessage.create();
        const messageAfterHandler = BarMessage.create();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(async () => messageAfterHandler)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(messageBeforeHandler);
        expectMessagesSentToBe([messageAfterHandler]);
    });

    test("message filter after handler", async () => {
        const messageBeforeHandler = FooMessage.create();
        const messageAfterHandler = BarMessage.create();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(async () => messageAfterHandler)
            .filter(() => false)
            .to(defaultOutputChannel)
            .settle()
            .start();

        await defaultInputChannel.send(messageBeforeHandler);
        expectMessagesSentToBe([]);
    });

    test("can select message handling template", async () => {
        const message = FooMessage.create();
        const handler = vi.fn();

        await testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(handler)
            .settle()
            .start();

        await defaultInputChannel.send(message);
        expect(handler).toHaveBeenCalledWith(message);
    });
});

describe("template", () => {
    const message = FooMessage.create();
    const handler = vi.fn();

    function withTemplate(
        template:
            | string
            | ((ctx: MessageHandlingContext<Message, any>) => Promise<void>)
    ): MessagePipeline {
        return testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(handler, {
                template,
            }) as any;
    }

    test("context.message", async () => {
        let messageTemplateReceived: Message | null = null;
        const template = async (ctx: MessageHandlingContext<Message, any>) => {
            messageTemplateReceived = ctx.message;
        };

        await withTemplate(template).settle().start();
        await defaultInputChannel.send(message);

        expect(messageTemplateReceived).toBe(message);
    });

    test("does not execute if ctx.handle() is not called", async () => {
        const template = async () => {};

        await withTemplate(template).settle().start();
        await defaultInputChannel.send(message);

        expect(handler).not.toHaveBeenCalled();
    });

    test("ctx.handle() returns the result", async () => {
        const result = BarMessage.create();
        handler.mockImplementation(() => result);
        let resultTemplateReceived: Message | null = null;
        const template = async (ctx: MessageHandlingContext<Message, any>) => {
            resultTemplateReceived = await ctx.handle();
        };

        await withTemplate(template).settle().start();
        await defaultInputChannel.send(message);

        expect(handler).toHaveBeenCalledWith(message);
        expect(resultTemplateReceived).toBe(result);
    });

    test("ctx.next() forwards the message to the next handler", async () => {
        const messageToForward = BarMessage.create();
        handler.mockImplementation(() => null);
        const handlerAfter = vi.fn();
        const template = async (ctx: MessageHandlingContext<Message, any>) => {
            await ctx.next(messageToForward);
        };

        await withTemplate(template).handle(handlerAfter).settle().start();
        await defaultInputChannel.send(message);

        expect(handler).not.toHaveBeenCalled();
        expect(handlerAfter).toHaveBeenCalledWith(messageToForward);
    });

    test("can refer template registered in the namespace by name", async () => {
        const outputMessage = BarMessage.create();
        testNamespace.registerTemplate(
            "my-template",
            (ctx: MessageHandlingContext<Message, any>) =>
                ctx.next(outputMessage)
        );

        await withTemplate("my-template")
            .to(defaultOutputChannel)
            .settle()
            .start();
        await defaultInputChannel.send(message);

        expect(handler).not.toHaveBeenCalled();
        expect(defaultOutputChannel.send).toHaveBeenCalledWith(outputMessage);
    });

    test("cannot refer non-existing template", async () => {
        expect(() => withTemplate("non-existing-template")).toThrowError(
            "not registered"
        );
    });
});

describe("injection", () => {
    function makeHandler(): MessageHandler<any, void> &
        ApplicationContextAware {
        return {
            handle: vi.fn(),
            setApplicationContext: vi.fn(),
        };
    }

    test("injects the application context into pipelines", async () => {
        const pipelineSetApplicationContext = vi.spyOn(
            MessagePipeline.prototype,
            "setApplicationContext"
        );
        testNamespace.define("pipeline1").from(new DirectChannel()).settle();
        testNamespace.define("pipeline2").from(new DirectChannel()).settle();

        testNamespace.setApplicationContext(dummyApplicationContext);
        expect(pipelineSetApplicationContext).not.toHaveBeenCalled();

        await testNamespace.start();
        expect(pipelineSetApplicationContext).toHaveBeenCalledTimes(2);
        for (const call of pipelineSetApplicationContext.mock.calls) {
            expect(call[0]).toBe(dummyApplicationContext);
        }
    });

    it("cannot start when the handler is ApplicationContextAware but no context is provided", async () => {
        const namespaceWithNoContextSet = new MessagePipelinesNamespace("new");
        namespaceWithNoContextSet
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(makeHandler())
            .settle();

        await expect(namespaceWithNoContextSet.start()).rejects.toThrowError(
            "failed to inject"
        );
    });

    test("injects the application context into handlers", async () => {
        const handlers = [makeHandler(), makeHandler()];
        const pipeline = testNamespace
            .define("pipeline-for-test")
            .from(defaultInputChannel)
            .handle(handlers[0])
            .handle(handlers[1])
            .settle();

        pipeline.setApplicationContext(dummyApplicationContext);
        await pipeline.start();

        for (const handler of handlers) {
            expect(handler.setApplicationContext).toHaveBeenCalledWith(
                dummyApplicationContext
            );
        }
    });
});

describe.todo("branching & routing messages", () => {
    // MessagePipeline.define("routing-example")
    //     .from(A)
    //     .route((message) => {
    //         if (message.type === "test") {
    //             return "->B";
    //         } else if (message.type === "test2") {
    //             return "->C";
    //         }
    //     })
    //     .branch('->B')
    //         .filter((message) => message.type === "test")
    //         .to(B)
    //     .branch('->C')
    //         .filter((message) => message.type === "test2")
    //         .to(C)
    //     .settle();
});

describe.todo("wiretapping", () => {
    // MessagePipeline.define("wiretapping-example")
    //     .from(A)
    //         .wiretap((message) => console.log('A'))
    //     .transform(transformer)
    //         .wiretap((message) => console.log('A->handler'))
    //     .handle(handler)
    //         .wiretap((message) => console.log('A->handler->B'))
    //     .to(B)
    //     .settle();
});

describe.todo("error handling", () => {
    // const customErrorChannel = new DirectChannel();
    // MessagePipeline.setGlobalErrorChannel(customErrorChannel);
    //
    // MessagePipeline.define("global-error-channel-example")
    //     .from(A)
    //     .handler(failingHandler)
    //     .to(B)
    //
    // MessagePipeline.define("local-error-channel-example")
    //     .from(A)
    //     .handler(failingHandler)
    //     .channelErrorsTo(customErrorChannel)
    //     .to(B)
    //
    // MessagePipeline.getGlobalErrorChannel().subscribe((error) => {
    //     // handle error
    // });
    //
    // MessagePipeline.select("*").observe(event => {
    //    // handle event
    // });
    // interface MessagingComponent {
    //     getMessagingComponentType(): string;
    // }
});
