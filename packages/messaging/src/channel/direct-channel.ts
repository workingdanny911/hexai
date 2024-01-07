import { Message } from "@hexai/core";

import { SubscribableMessageChannel } from "./subscribable-message-channel";

export class DirectChannel implements SubscribableMessageChannel {
    private callback?: (message: Message) => void | Promise<void>;

    subscribe(callback: (message: Message) => void | Promise<void>): void {
        if (this.callback) {
            throw new Error(
                "only one subscriber can subscribe to a direct channel"
            );
        }

        this.callback = callback;
    }

    async send(message: Message): Promise<void> {
        if (!this.callback) {
            throw new Error("no subscriber to send message to");
        }

        await this.callback(message);
    }
}
