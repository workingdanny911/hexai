import { Event } from "@/event";

export type DomainEvent<
    T extends string = string,
    P extends Record<string, any> = Record<string, unknown>,
> = Event<T, P>;
