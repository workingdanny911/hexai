import type { StoredEvent } from "@hexaijs/core";

export interface Selector {
    method: string;
    predicate(storedEvent: StoredEvent): boolean;
}

export function When(
    predicate: (storedEvent: StoredEvent) => boolean
): MethodDecorator {
    return function (target: any, propertyKey: string | symbol) {
        target.constructor.registerSelector({
            method: propertyKey.toString(),
            predicate,
        });
    };
}

export function eventTypeMatches(
    type: string | string[] | RegExp
): (storedEvent: StoredEvent) => boolean {
    if (Array.isArray(type)) {
        return (storedEvent) =>
            type.includes(storedEvent.event.getMessageType());
    }

    if (type instanceof RegExp) {
        return (storedEvent) => type.test(storedEvent.event.getMessageType());
    }

    return (storedEvent) => storedEvent.event.getMessageType() === type;
}
