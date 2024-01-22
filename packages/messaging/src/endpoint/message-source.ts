import { Message } from "@hexai/core";

import { Lifecycle } from "@/lifecycle";

export interface MessageSource<M extends Message = Message> extends Lifecycle {
    receive(): Promise<M | null>;
}
