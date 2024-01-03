import { Message } from "@hexai/core/message";

import { MessageHandler, SubscribableMessageChannel } from "@/types";

export class DirectChannel implements SubscribableMessageChannel {
    private handler?: MessageHandler<Message, unknown>;

    subscribe(handler: MessageHandler<Message, unknown>): void {
        if (this.handler) {
            throw new Error(
                "only one subscriber can subscribe to a direct channel"
            );
        }

        this.handler = handler;
    }

    async send(message: Message): Promise<boolean> {
        if (!this.handler) {
            throw new Error("no subscriber to send message to");
        }

        try {
            await this.handler(message);
            return true;
        } catch {
            return false;
        }
    }
}
