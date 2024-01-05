import { Message } from "@hexai/core/message";
import {
    ApplicationContextAware,
    ApplicationContextInjector,
} from "@hexai/core/injection";
import { BaseApplicationContext } from "@hexai/core/application";

import {
    AbstractLifecycle,
    isInboundChannelAdapter,
    isSubscribableChannel,
} from "@/helpers";
import { Pipe } from "@/pipe";
import {
    DirectChannel,
    MessageChannel,
    SubscribableMessageChannel,
} from "@/channel";
import {
    InboundChannelAdapter,
    MessageFilter,
    MessageHandler,
    MessageHandlerFunction,
} from "@/endpoint";
import { Lifecycle } from "@/lifecycle";

type OmitLifecycleMethods<T> = Omit<T, keyof Lifecycle>;

type IntermediateMessagePipeline<
    AC extends BaseApplicationContext = BaseApplicationContext,
    I = Message,
> = OmitLifecycleMethods<MessagePipeline<AC, I>>;

interface HandlerConfig<
    AC extends BaseApplicationContext,
    I = unknown,
    O = unknown,
> {
    name?: string;
    template?:
        | string
        | ((ctx: MessageHandlingContext<AC, I, O>) => Promise<void>);
}

export interface MessageHandlingTemplate<
    AC extends BaseApplicationContext = BaseApplicationContext,
    I = unknown,
    O = unknown,
> {
    (ctx: MessageHandlingContext<AC, I, O>): Promise<void>;
}

export interface MessageHandlingContext<
    AC extends BaseApplicationContext = BaseApplicationContext,
    I = unknown,
    O = unknown,
> {
    message: I;
    applicationContext: AC;
    pipelineName: string;
    handlerName: string;

    handle: () => O | Promise<O>;
    next(message: O): Promise<void>;
    reject(error: Error): Promise<void>;
}

type AnyMessageHandlingTemplate = MessageHandlingTemplate<any, any, any>;

type InboundChannel = SubscribableMessageChannel | InboundChannelAdapter;

export class MessagePipeline<
        AC extends BaseApplicationContext = BaseApplicationContext,
        I = Message,
    >
    extends AbstractLifecycle
    implements ApplicationContextAware<AC>
{
    private applicationContextInjector = new ApplicationContextInjector();
    private applicationContext!: AC;
    private inputChannel!: SubscribableMessageChannel;
    private outputChannel?: MessageChannel;
    private pipe: Pipe<any, any> = Pipe.from<I, I>((message, { next }) => {
        if (this.isRunning()) {
            return next(message);
        }
    });
    private resources: Lifecycle[] = [];
    private isSettled = false;

    private constructor(
        private namespace: MessagePipelinesNamespace,
        private name: string
    ) {
        super();
    }

    public getName(): string {
        return this.name;
    }

    public setApplicationContext(context: AC): void {
        this.applicationContext = context;
        this.applicationContextInjector.setInjectingObject(context);
    }

    public from(
        channel: SubscribableMessageChannel
    ): IntermediateMessagePipeline<AC>;

    public from(
        adapter: InboundChannelAdapter
    ): IntermediateMessagePipeline<AC>;

    public from(
        channelOrAdapter: InboundChannel
    ): IntermediateMessagePipeline<AC> {
        if (isSubscribableChannel(channelOrAdapter)) {
            this.inputChannel = channelOrAdapter;
        } else if (isInboundChannelAdapter(channelOrAdapter)) {
            this.inputChannel = this.connectInboundAdapter(channelOrAdapter);
        } else {
            throw new Error(
                "the provided argument is not " +
                    "a subscribable channel or an inbound channel adapter"
            );
        }

        return this as any;
    }

    private connectInboundAdapter(
        adapter: InboundChannelAdapter
    ): SubscribableMessageChannel {
        const channel = new DirectChannel();

        this.resources.push(adapter);
        adapter.setOutputChannel(channel);

        return channel;
    }

    public to(channel: MessageChannel): IntermediateMessagePipeline<AC, I> {
        if (this.outputChannel) {
            throw new Error("output channel already set");
        }

        this.outputChannel = channel;
        return this;
    }

    public filter(
        filter: MessageFilter<I>
    ): IntermediateMessagePipeline<AC, I> {
        const filterPipe = Pipe.from<I, I>((m, { next }) => {
            if (typeof filter === "function") {
                filter = { select: filter };
            }

            if (filter.select(m)) {
                return next(m);
            }
        });

        this.pipe = this.pipe.extend(filterPipe);
        return this as any;
    }

    public transform<O>(
        transformer: O extends void ? never : MessageHandler<I, O>
    ): IntermediateMessagePipeline<AC, O> {
        return this.handle(transformer);
    }

    public handle<O>(
        handler: MessageHandler<I, O>,
        config?: HandlerConfig<AC, I, O>
    ): IntermediateMessagePipeline<AC, O> {
        this.applicationContextInjector.addCandidate(handler);

        const handle = this.toHandlerFunction(handler);
        const template = this.resolveTemplate(config?.template);
        const handlerName = this.resolveHandlerName(handler, config?.name);

        const handlerPipe = Pipe.from<I, O>(async (message, { next }) => {
            const ctx: MessageHandlingContext<AC, I, O> = {
                message,
                pipelineName: this.name,
                handlerName,
                applicationContext: this.applicationContext,
                handle: () => handle(message),
                next: (message: O) => {
                    return next(message);
                },
                reject: async (error: Error) => {
                    throw error;
                },
            };

            if (template) {
                await template(ctx);
            } else {
                await next(await handle(message));
            }
        });

        this.pipe = this.pipe.extend(handlerPipe);

        return this as any;
    }

    private toHandlerFunction(
        handler: MessageHandler<any, any>
    ): MessageHandlerFunction<any, any> {
        if (typeof handler === "function") {
            return handler;
        } else {
            return handler.handle.bind(handler);
        }
    }

    private resolveTemplate(
        template?: string | AnyMessageHandlingTemplate
    ): null | AnyMessageHandlingTemplate {
        if (!template) {
            return null;
        }

        if (typeof template === "string") {
            return this.namespace.getTemplate(template);
        }

        return template;
    }

    private resolveHandlerName(
        handler: MessageHandler<any, any>,
        name?: string
    ): string {
        if (name) {
            return name;
        }

        if (typeof handler === "function") {
            return handler?.name ?? "anonymous";
        }

        return handler.constructor.name;
    }

    public settle(): Lifecycle & ApplicationContextAware<AC> {
        if (!this.inputChannel) {
            throw new Error("no input channel provided");
        }

        this.isSettled = true;
        (this.namespace as any).registerPipeline(this);

        return this;
    }

    protected override async onStart(): Promise<void> {
        if (!this.isSettled) {
            throw new Error(
                "message pipeline is not settled. " +
                    "call 'settle()' method before starting the pipeline"
            );
        }

        try {
            this.applicationContextInjector.inject();
        } catch (e) {
            throw new Error(
                "failed to inject application context into message pipeline: " +
                    e
            );
        }

        this.startInputChannel();
        await this.startResources();
    }

    protected override async onStop(): Promise<void> {
        await Promise.all(this.resources.map((r) => r.stop()));
    }

    private startInputChannel(): void {
        this.inputChannel.subscribe(async (message) => {
            await this.pipe
                .extend((message) => {
                    this.outputChannel!.send(message);
                })
                .send(message);
        });
    }

    private async startResources(): Promise<void> {
        await Promise.all(this.resources.map((r) => r.start()));
    }
}

export class MessagePipelinesNamespace<
        AC extends BaseApplicationContext = BaseApplicationContext,
    >
    extends AbstractLifecycle
    implements ApplicationContextAware<AC>
{
    private static namespaceRegistry: Record<
        string,
        MessagePipelinesNamespace
    > = {};
    private applicationContextInjector = new ApplicationContextInjector();
    private pipelines: Record<string, MessagePipeline> = {};
    private templates: Record<string, (ctx: any) => Promise<void>> = {};

    public static clearRegistry(): void {
        MessagePipelinesNamespace.namespaceRegistry = {};
    }

    constructor(private name: string) {
        super();

        if (!isNonEmptyString(name)) {
            throw new Error("namespace must be a non-empty string");
        }

        if (MessagePipelinesNamespace.namespaceRegistry[name]) {
            throw new Error(`namespace '${name}' already defined`);
        }

        MessagePipelinesNamespace.namespaceRegistry[name] = this;
    }

    public getName(): string {
        return this.name;
    }

    public setApplicationContext(context: AC) {
        this.applicationContextInjector.setInjectingObject(context);
    }

    protected override async onStart(): Promise<void> {
        try {
            this.applicationContextInjector.inject();
        } catch (e) {
            throw new Error(
                "failed to inject application context into message pipelines namespace: " +
                    e
            );
        }
        await this.startAllPipelines();
    }

    private async startAllPipelines(): Promise<void> {
        await Promise.all(Object.values(this.pipelines).map((p) => p.start()));
    }

    protected override async onStop(): Promise<void> {
        await this.stopAllPipelines();
    }

    private async stopAllPipelines(): Promise<void> {
        const runningPipelines = Object.values(this.pipelines).filter((p) =>
            p.isRunning()
        );
        await Promise.all(runningPipelines.map((p) => p.stop()));
    }

    public define(name: string): Pick<MessagePipeline<AC>, "from"> {
        if (!isNonEmptyString(name)) {
            throw new Error("name must be a non-empty string");
        }

        if (this.pipelines[name]) {
            throw new Error(`pipeline with name '${name}' already defined`);
        }

        return new (MessagePipeline as any)(this, name);
    }

    private registerPipeline(pipeline: MessagePipeline): void {
        this.pipelines[pipeline.getName()] = pipeline;
        this.applicationContextInjector.addCandidate(pipeline);
    }

    public registerTemplate(
        name: string,
        template: (ctx: MessageHandlingContext) => Promise<void>
    ): MessagePipelinesNamespace<AC> {
        this.templates[name] = template;

        return this;
    }

    public getTemplate(name: string): MessageHandlingTemplate {
        if (!this.templates[name]) {
            throw new Error(`template with name '${name}' not registered`);
        }

        return this.templates[name];
    }
}

function isNonEmptyString(s: unknown): s is string {
    return typeof s === "string" && s.length > 0;
}
