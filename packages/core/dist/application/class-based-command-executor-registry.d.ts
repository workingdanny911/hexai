import { C } from "ts-toolbelt";
import { Message } from "../message";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";
export declare class ClassBasedCommandExecutorRegistry implements CommandExecutorRegistry<C.Class, Message> {
    private handlers;
    register(key: C.Class, executor: CommandExecutor<Message>): void;
    get(command: Message): CommandExecutor<Message> | null;
}
//# sourceMappingURL=class-based-command-executor-registry.d.ts.map