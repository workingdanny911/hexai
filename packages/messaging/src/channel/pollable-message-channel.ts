import { Message } from "@hexai/core/message";

import { MessageChannel } from "./message-channel";

export interface PollableMessageChannel extends MessageChannel {
    receive(): Promise<Message>;
}
