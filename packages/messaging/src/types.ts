import { Message } from "@hexai/core/message";

export interface MessageChannel {
    send(message: Message): Promise<boolean>;
}

export interface PollableMessageChannel extends MessageChannel {
    receive(): Promise<Message>;
}

export interface SubscribableMessageChannel extends MessageChannel {
    subscribe(callback: (message: Message) => void | Promise<void>): void;
}

export interface IdempotencySupport {
    isDuplicate(key: string, message: Message, ttl?: number): Promise<boolean>;
    markAsProcessed(key: string, message: Message): Promise<void>;
}

export interface Lifecycle {
    isRunning(): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
}

export interface InboundChannelAdapter extends Lifecycle {
    setOutputChannel(channel: MessageChannel): void;
}

export interface OutboundChannelAdapter extends MessageChannel, Lifecycle {}

export interface MessageSource extends Lifecycle {
    receive(): Promise<Message | null>;
}

export interface MessageSourcePoller extends Lifecycle {
    onPoll(callback: () => Promise<void>): void;
}

export interface MessageFilter<M> {
    select(message: M): boolean | Promise<boolean>;
}

export type MessageFilterFunction<M> = MessageFilter<M>["select"];

export interface MessageHandler<I, O> {
    handle(message: I): O | Promise<O>;
}

export type MessageHandlerFunction<I, O> = MessageHandler<I, O>["handle"];
