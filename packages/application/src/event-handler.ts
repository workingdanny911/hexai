import { AnyMessage, Message } from "@hexaijs/core";

export interface EventHandler<E extends Message = Message, Ctx = any> {
    canHandle(message: AnyMessage): boolean;
    handle(event: E, applicationContext: Ctx): Promise<void>;
}
