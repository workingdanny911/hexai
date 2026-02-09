import { Command } from "@hexaijs/application";

export class UpdateUserCommand extends Command<
    { id: string; name: string },
    { role: string }
> {
    constructor(payload: { id: string; name: string }, sc: { role: string }) {
        super(payload, { securityContext: sc });
    }
}
