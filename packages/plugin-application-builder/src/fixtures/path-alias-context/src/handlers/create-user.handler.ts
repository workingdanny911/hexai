import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateUserCommand } from "@/commands/create-user/request";

@CommandHandlerMarker(CreateUserCommand)
export class CreateUserHandler {
    async execute(command: CreateUserCommand): Promise<{ id: string }> {
        return { id: "123" };
    }
}
