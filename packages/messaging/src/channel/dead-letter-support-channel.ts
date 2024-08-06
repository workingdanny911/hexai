import { Message } from "@hexai/core";

import { MessageChannel } from "./message-channel";

export interface DeadLetterSupportChannel extends MessageChannel {
    sendToDeadLetter(message: Message): Promise<void>;
    // receiveFromDeadLetter(): Promise<Message>;
}
