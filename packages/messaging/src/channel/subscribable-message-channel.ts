import { Message } from "@hexai/core";

import { MessageChannel } from "./message-channel";

export interface SubscribableMessageChannel extends MessageChannel {
    subscribe(callback: (message: Message) => void | Promise<void>): void;
}
