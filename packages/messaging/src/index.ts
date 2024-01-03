import { Message } from "@hexai/core/message";

export interface MessageChannel {
    send(message: Message): Promise<void>;
}

export interface PollableMessageChannel extends MessageChannel {
    receive(): Promise<Message>;
}

export interface SubscribableMessageChannel extends MessageChannel {
    subscribe(callback: MessageHandler): void;
}

interface MessageHandler<R = void> {
    (message: Message): Promise<R>;
}

interface MessageSelector {
    select(message: Message): boolean;
}
