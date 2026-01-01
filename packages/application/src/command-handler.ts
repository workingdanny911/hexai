import { Command } from "@/command";

export interface CommandHandler<
    I extends Command = Command,
    O = any,
    Ctx = any,
> {
    execute(command: I, ctx?: Ctx): Promise<O>;
}
