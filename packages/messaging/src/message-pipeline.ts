import { Message } from "@hexai/core/message";

import {
    BaseLifecycle,
    isInboundChannelAdapter,
    isSubscribableChannel,
} from "@/helpers";
import {
    InboundChannelAdapter,
    Lifecycle,
    MessageChannel,
    MessageFilter,
    MessageFilterFunction,
    MessageHandler,
    MessageHandlerFunction,
    SubscribableMessageChannel,
} from "@/types";
import { Pipe } from "@/pipe";
import { DirectChannel } from "@/channel";

export class MessageFlow<I> extends BaseLifecycle {
    private inputChannel: SubscribableMessageChannel;
    private outputChannel?: MessageChannel;
    private pipe = Pipe.passThrough<any>();
    private resources: Lifecycle[] = [];

    private constructor(
        inputChannel: SubscribableMessageChannel,
        resources: Lifecycle[]
    ) {
        super();
        this.inputChannel = inputChannel;
        this.resources = resources;
    }

    public static from(
        channel: SubscribableMessageChannel | InboundChannelAdapter
    ): MessageFlow<Message> {
        const resources: Lifecycle[] = [];
        let inputChannel: SubscribableMessageChannel;

        if (isSubscribableChannel(channel)) {
            inputChannel = channel;
        } else if (isInboundChannelAdapter(channel)) {
            resources.push(channel);
            inputChannel = new DirectChannel();
            channel.setOutputChannel(inputChannel);
        } else {
            throw new Error(
                "the provided argument is not " +
                    "a subscribable channel or an inbound channel adapter"
            );
        }

        return new this(inputChannel, resources);
    }

    public to(channel: MessageChannel): MessageFlow<I> {
        if (this.outputChannel) {
            throw new Error("output channel already set");
        }

        this.outputChannel = channel;
        return this;
    }

    public filter(
        filter: MessageFilter<I> | MessageFilterFunction<I>
    ): MessageFlow<I> {
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
        transformer: O extends void
            ? never
            : MessageHandler<I, O> | MessageHandlerFunction<I, O>
    ): MessageFlow<O> {
        this.handle(transformer);
        return this as any;
    }

    public handle<O>(
        handler: MessageHandler<I, O> | MessageHandlerFunction<I, O>
    ): MessageFlow<O> {
        const handlerPipe = Pipe.from<I, O>(async (m, { next }) => {
            if (typeof handler === "function") {
                handler = { handle: handler };
            }

            return next(await handler.handle(m));
        });

        this.pipe = this.pipe.extend(handlerPipe);

        return this as any;
    }

    public settle(): Lifecycle {
        if (!this.inputChannel) {
            throw new Error("no input channel provided");
        }

        return this;
    }

    public async start(): Promise<void> {
        this.startInputChannel();
        await super.start();
        await this.startResources();
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
