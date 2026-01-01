import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";

// NonExistentCommand is not imported and not defined in this file
@CommandHandlerMarker(NonExistentCommand)
export class CreateUserHandler {
    async execute(command: any): Promise<{ id: string }> {
        return { id: "123" };
    }
}
