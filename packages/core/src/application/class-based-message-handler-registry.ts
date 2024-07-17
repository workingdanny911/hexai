import { C } from "ts-toolbelt";

import { Message } from "@/message";
import { isClass } from "@/utils";
import { MessageHandlerRegistry } from "./message-handler-registry";
import { MessageHandler } from "./message-handler";

export class ClassBasedMessageHandlerRegistry
    implements MessageHandlerRegistry<C.Class, Message>
{
    private handlers = new Map<C.Class, MessageHandler<Message>>();

    public register(key: C.Class, executor: MessageHandler<Message>): void {
        if (!isClass(key)) {
            throw new Error(`${key} is not a class`);
        }

        if (this.handlers.has(key)) {
            throw new Error("already registered");
        }

        this.handlers.set(key, executor);
    }

    public getByMessage(command: Message): MessageHandler<Message> | null {
        const commandClass = command.constructor as C.Class;

        return this.handlers.get(commandClass) ?? null;
    }
}
