export interface CommandExecutor<I = any, O = any> {
    execute(command: I): Promise<O>;
}

export type CommandTypeOf<H extends CommandExecutor<any, any>> =
    H extends CommandExecutor<infer I, any> ? I : never;
