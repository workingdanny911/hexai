import { CreateUserCommand } from "./create-user.command.js";

function CommandHandlerMarker(_message: unknown): ClassDecorator {
    return () => undefined;
}

@CommandHandlerMarker(CreateUserCommand)
export class CreateUserHandler {
    async execute(command: CreateUserCommand): Promise<{ name: string }> {
        return { name: command.name };
    }
}
