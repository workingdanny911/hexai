import { Command } from "@/command";

export interface CommandHandler<I extends Command = Command, Ctx = any> {
    execute(command: I, ctx?: Ctx): Promise<I['ResultType']>;
}
