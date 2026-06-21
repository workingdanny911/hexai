import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateUserCommand } from "@app/commands/create-user/request.js";

@CommandHandlerMarker(CreateUserCommand)
export class CreateUserHandler {
    async execute(command: CreateUserCommand): Promise<{ id: string }> {
        return { id: "123" };
    }
}
