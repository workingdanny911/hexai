import { Command } from "@hexaijs/application";
import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";

export class CreateUserCommand extends Command<
    { name: string },
    { role: string }
> {
    constructor(payload: { name: string }, sc: { role: string }) {
        super(payload, { securityContext: sc });
    }
}

@CommandHandlerMarker(CreateUserCommand)
export class CreateUserHandler {
    async execute(command: CreateUserCommand): Promise<{ id: string }> {
        return { id: "123" };
    }
}
