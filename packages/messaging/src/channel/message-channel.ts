import { Message } from "@hexai/core";

export interface MessageChannel {
    send(message: Message): Promise<void>;
}
