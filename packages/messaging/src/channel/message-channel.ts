import { Message } from "@hexai/core/message";

export interface MessageChannel {
    send(message: Message): Promise<boolean>;
}
