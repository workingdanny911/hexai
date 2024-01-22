import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";

export class CommandExecutorRegistryForTest
    implements CommandExecutorRegistry<string, object>
{
    private handlers: Record<string, CommandExecutor<object, any>> = {};

    register(key: string, handler: CommandExecutor<object, any>): void {
        if (this.handlers[key]) {
            throw new Error("already registered");
        }

        this.handlers[key] = handler;
    }

    get(message: object): CommandExecutor<object, any> | null {
        return this.handlers[(message as any).type] ?? null;
    }
}
