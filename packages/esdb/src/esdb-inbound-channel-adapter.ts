import {
    EventStoreDBClient,
    JSONEventType,
    PersistentSubscriptionDroppedError,
    PersistentSubscriptionExistsError,
    PersistentSubscriptionToStream,
    PersistentSubscriptionToStreamSettings,
    persistentSubscriptionToStreamSettingsFromDefaults,
    ResolvedEvent,
} from "@eventstore/db-client";
import { AbstractInboundChannelAdapter } from "@hexai/messaging";
import { Message } from "@hexai/core";

import { EsdbHelper } from "@/esdb-helper";

export interface EsdbInboundChannelAdapterConfig {
    stream: string;
    group: string;
    initialPosition?: "start" | "end" | number | bigint;
    timeout?: number;
    maxRetries?: number;
}

export class EsdbInboundChannelAdapter extends AbstractInboundChannelAdapter {
    private subscription?: PersistentSubscriptionToStream;
    private session?: AsyncIterableIterator<any>;
    private interval?: NodeJS.Timeout;
    private callbacks: Record<
        string,
        {
            ack: () => Promise<void>;
            nack: (reason?: string) => Promise<void>;
        }
    > = {};

    constructor(
        private client: EventStoreDBClient,
        private config: EsdbInboundChannelAdapterConfig
    ) {
        super();
    }

    protected override async onStart(): Promise<void> {
        await this.initializeConsumerGroup();
        await this.startSubscribing();
    }

    private async initializeConsumerGroup(): Promise<void> {
        const { stream, group } = this.config;

        try {
            await this.client.createPersistentSubscriptionToStream(
                stream,
                group,
                this.subscriptionSettings()
            );
        } catch (e) {
            if (e instanceof PersistentSubscriptionExistsError) {
                // ignore
            } else {
                throw e;
            }
        }
    }

    private subscriptionSettings(): PersistentSubscriptionToStreamSettings {
        const { timeout, maxRetries, initialPosition } = this.config;
        const defaults = persistentSubscriptionToStreamSettingsFromDefaults();
        const startFrom = initialPosition
            ? typeof initialPosition === "string"
                ? initialPosition
                : BigInt(initialPosition)
            : "start";

        return {
            ...defaults,
            startFrom,
            maxRetryCount: maxRetries ?? defaults.maxRetryCount,
            messageTimeout: timeout ?? defaults.messageTimeout,
        };
    }

    private async startSubscribing(): Promise<void> {
        this.subscription =
            this.client.subscribeToPersistentSubscriptionToStream<JSONEventType>(
                this.config.stream,
                this.config.group
            );

        this.session = this.subscription[Symbol.asyncIterator]();
        this.interval = setInterval(() => this.processMessage());
    }

    protected override async onStop(): Promise<void> {
        clearInterval(this.interval!);
        await this.subscription?.unsubscribe();
    }

    protected async receiveMessage(): Promise<Message | null> {
        try {
            const { value } = await this.session!.next();
            if (value === undefined) {
                return null;
            }

            this.registerCallbacks(value);

            return EsdbHelper.deserialize(value.event);
        } catch (e) {
            if (e instanceof PersistentSubscriptionDroppedError) {
                return null;
            }

            throw e;
        }
    }

    private registerCallbacks(raw: ResolvedEvent<JSONEventType>) {
        this.callbacks[raw.event!.id] = {
            ack: () => this.subscription!.ack(raw),
            nack: (reason?: string) =>
                this.subscription!.nack("retry", reason ?? "", raw),
        };
    }

    protected override async afterSend(
        message: Message,
        error?: Error
    ): Promise<void> {
        if (error) {
            await this.callbacks[message.getMessageId()].nack(error.message);
        } else {
            await this.callbacks[message.getMessageId()].ack();
        }

        delete this.callbacks[message.getMessageId()];
    }
}
