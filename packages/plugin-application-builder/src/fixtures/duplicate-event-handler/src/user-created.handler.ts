import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";

@EventHandlerMarker({ name: "user-created" })
export class UserCreatedEventHandler {
    async handle(event: any): Promise<void> {
        // Handle event
    }
}
