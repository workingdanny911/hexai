import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { UpdateUserCommand } from "./update-user.command";

@CommandHandlerMarker(UpdateUserCommand)
export class UpdateUserHandler {
    async execute(command: UpdateUserCommand): Promise<{ id: string }> {
        return { id: command.getPayload().id };
    }
}
