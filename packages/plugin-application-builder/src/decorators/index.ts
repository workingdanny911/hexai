import type { MessageClass } from "@hexaijs/core";

export interface EventHandlerOptions {
    name?: string;
}

/**
 * Creates a marker decorator for message handlers (command/query)
 * These are purely markers for build-time code generation with no runtime behavior
 */
function createMessageHandlerMarker() {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return function (messageClass: MessageClass) {
        return function <T extends { new (...args: any[]): any }>(target: T) {
            return target;
        };
    };
}

/**
 * Decorator to mark a class as a command handler
 * This is purely a marker for build-time code generation
 */
export const CommandHandlerMarker = createMessageHandlerMarker();

/**
 * Decorator to mark a class as a query handler
 * This is purely a marker for build-time code generation
 */
export const QueryHandlerMarker = createMessageHandlerMarker();

/**
 * Decorator to mark a class as an event handler
 * This is purely a marker for build-time code generation
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function EventHandlerMarker(options?: EventHandlerOptions) {
    return function <T extends { new (...args: any[]): any }>(target: T) {
        return target;
    };
}
