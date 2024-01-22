import {
    ApplicationContextAware,
    ApplicationContextInjector,
    Message,
} from "@hexai/core";

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
    MessageHandlerTemplate,
    toHandlerFunction,
} from "@/endpoint";
import { Lifecycle } from "@/lifecycle";

type OmitLifecycleMethods<T> = Omit<T, keyof Lifecycle>;

type IntermediateMessagePipeline<
    AC extends object = object,
    I = Message,
> = OmitLifecycleMethods<MessagePipeline<AC, I>>;

interface HandlerConfig {
    name?: string;
    template?: string | MessageHandlerTemplate;
}

type InboundChannel = SubscribableMessageChannel | InboundChannelAdapter;

export class MessagePipeline<AC extends object = object, I = Message>
    extends AbstractLifecycle
    implements ApplicationContextAware<AC>
{
    private applicationContextInjector = new ApplicationContextInjector();
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
        config?: HandlerConfig
    ): IntermediateMessagePipeline<AC, O> {
        this.markToInjectApplicationContext(handler);

        const handle = toHandlerFunction(handler);
        const template = this.resolveTemplate(config?.template);
        if (template) {
            this.markToInjectApplicationContext(template);
        }

        const handlerPipe = Pipe.from<I, O>(async (message, { next }) => {
            if (template) {
                template.setMessageHandler(handler);
                await next(await template.handle(message));
            } else {
                await next(await handle(message));
            }
        });

        this.pipe = this.pipe.extend(handlerPipe);

        return this as any;
    }

    private markToInjectApplicationContext(obj: unknown): void {
        this.applicationContextInjector.addCandidate(obj);
    }

    private resolveTemplate(
        template?: string | MessageHandlerTemplate
    ): null | MessageHandlerTemplate {
        if (!template) {
            return null;
        }

        if (typeof template === "string") {
            return this.namespace.getTemplate(template);
        }

        return template;
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
            if (this.outputChannel) {
                await this.getPipeToOutputChannel().send(message);
            } else {
                await this.pipe.send(message);
            }
        });
    }

    private getPipeToOutputChannel(): Pipe<Message, void> {
        return this.pipe.extend(
            Pipe.from<Message, void>(async (message) => {
                await this.outputChannel!.send(message);
            })
        );
    }

    private async startResources(): Promise<void> {
        await Promise.all(this.resources.map((r) => r.start()));
    }
}

export class MessagePipelinesNamespace<AC extends object = object>
    extends AbstractLifecycle
    implements ApplicationContextAware<AC>
{
    private static namespaceRegistry: Record<
        string,
        MessagePipelinesNamespace
    > = {};
    private applicationContextInjector = new ApplicationContextInjector();
    private pipelines: Record<string, MessagePipeline> = {};
    private templates: Record<string, MessageHandlerTemplate> = {};

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
        template: MessageHandlerTemplate
    ): MessagePipelinesNamespace<AC> {
        this.templates[name] = template;

        return this;
    }

    public getTemplate(name: string): MessageHandlerTemplate {
        if (!this.templates[name]) {
            throw new Error(`template with name '${name}' not registered`);
        }

        return this.templates[name];
    }
}

function isNonEmptyString(s: unknown): s is string {
    return typeof s === "string" && s.length > 0;
}
