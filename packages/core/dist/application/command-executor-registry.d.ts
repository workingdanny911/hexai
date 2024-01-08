import { CommandExecutor } from "./command-executor";
export interface CommandExecutorRegistry<K, M> {
    register(key: K, executor: CommandExecutor<M>): void;
    get(message: M): CommandExecutor<M> | null;
}
//# sourceMappingURL=command-executor-registry.d.ts.map