import { Command } from "@hexaijs/application";

export class CreateUserCommand extends Command<
    { name: string },
    { role: string }
> {
    constructor(payload: { name: string }, sc: { role: string }) {
        super(payload, sc);
    }
}
