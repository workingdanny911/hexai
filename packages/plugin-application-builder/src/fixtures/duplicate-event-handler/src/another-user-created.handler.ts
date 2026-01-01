import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";

@EventHandlerMarker({ name: "user-created" })
export class AnotherUserCreatedEventHandler {
    async handle(event: any): Promise<void> {
        // Handle event differently
    }
}
