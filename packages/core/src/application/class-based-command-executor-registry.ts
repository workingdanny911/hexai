import { C } from "ts-toolbelt";

import { Message } from "@/message";
import { isClass } from "@/utils";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";

export class ClassBasedCommandExecutorRegistry
    implements CommandExecutorRegistry<C.Class, Message>
{
    private handlers = new Map<C.Class, CommandExecutor<Message>>();

    public register(key: C.Class, executor: CommandExecutor<Message>): void {
        if (!isClass(key)) {
            throw new Error(`${key} is not a class`);
        }

        if (this.handlers.has(key)) {
            throw new Error("already registered");
        }

        this.handlers.set(key, executor);
    }

    public get(command: Message): CommandExecutor<Message> | null {
        const commandClass = command.constructor as C.Class;

        return this.handlers.get(commandClass) ?? null;
    }
}
