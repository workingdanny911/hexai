import { EventHandlerMarker } from "@hexaijs/plugin-application-builder";

// @ts-expect-error Invalid option should cause a type error
@EventHandlerMarker({ name: "some-event", invalidOption: true })
export class InvalidEventHandler {
    async execute(): Promise<void> {
        // noop
    }
}
