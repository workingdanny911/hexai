import { InboundChannelAdapter, MessageChannel } from "@hexai/messaging";
import {
    ApplicationContextAware,
    Message,
    AbstractLifecycle,
} from "@hexai/core";

import { EsdbClientProvider, PositionTrackerProvider } from "@/providers";
import { EsdbHelper } from "@/esdb-helper";

export type ContextForEsdbPollingChannelAdapter = EsdbClientProvider &
    PositionTrackerProvider;

export class EsdbPollingChannelAdapter
    extends AbstractLifecycle
    implements
        InboundChannelAdapter,
        ApplicationContextAware<ContextForEsdbPollingChannelAdapter>
{
    private id: string;
    private out: MessageChannel | null = null;
    private ctx: ContextForEsdbPollingChannelAdapter | null = null;
    private maxMessages = 10;
    private startingPosition = 0n;

    constructor(
        private config: {
            id: string;
            stream: string;
            maxMessages?: number;
        }
    ) {
        super();
        this.id = config.id;
        this.maxMessages = config.maxMessages ?? this.maxMessages;
    }

    public getId(): string {
        return this.id;
    }

    public setApplicationContext(
        context: ContextForEsdbPollingChannelAdapter
    ): void {
        this.ctx = context;
    }

    public setOutputChannel(channel: MessageChannel): void {
        this.out = channel;
    }

    protected override async onStart(): Promise<void> {
        if (!this.out) {
            throw new Error("no output channel set");
        }

        if (!this.ctx) {
            throw new Error("no application context set");
        }

        await this.initialize();
        await this.poll();
    }

    private async initialize(): Promise<void> {
        const positionTracker = this.ctx!.getPositionTracker();
        const lastPosition = await positionTracker.getLastPosition(
            this.getId(),
            this.config.stream
        );
        this.startingPosition = lastPosition + 1n;
    }

    private async poll() {
        const messages = await this.readMessages();

        for (const message of messages) {
            const error = await this.send(message);

            if (error) {
                return;
            } else {
                this.increaseLastPosition();
            }
        }

        await this.storeLastPosition();
    }

    private async readMessages(): Promise<Message[]> {
        const esdb = new EsdbHelper(this.ctx!.getEsdbClient());
        const messages = await esdb.readStream(this.config.stream, {
            fromPosition: this.startingPosition,
            numberOfEvents: this.maxMessages,
        });

        return messages;
    }

    private async send(message: Message): Promise<Error | undefined> {
        try {
            await this.out!.send(message);
        } catch (e) {
            return e as Error;
        }
    }

    private increaseLastPosition(): void {
        this.startingPosition += 1n;
    }

    private async storeLastPosition(): Promise<void> {
        const positionTracker = this.ctx!.getPositionTracker();

        await positionTracker.keepTrackOf(
            this.getId(),
            this.config.stream,
            Number(this.startingPosition - 1n)
        );
    }
}
