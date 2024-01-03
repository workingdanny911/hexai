import { Message } from "@hexai/core/message";

import { Lifecycle } from "@/lifecycle";

export interface MessageSource extends Lifecycle {
    receive(): Promise<Message | null>;
}
