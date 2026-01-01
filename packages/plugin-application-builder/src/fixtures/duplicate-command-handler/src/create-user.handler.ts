import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateUserCommand } from "./create-user.command";

@CommandHandlerMarker(CreateUserCommand)
export class CreateUserHandler {
    async execute(command: CreateUserCommand): Promise<{ id: string }> {
        return { id: "123" };
    }
}
