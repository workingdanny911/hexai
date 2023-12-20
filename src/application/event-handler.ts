import { Event } from "Hexai/message";
import { Factory } from "Hexai/utils";

export interface EventHandler<E extends Event = Event> {
    handle(event: E): Promise<void>;
}

export interface EventHandlerMeta {
    name: string;
    index: number;
    idempotent: boolean;
}

export type EventHandlerFactory<Ctx, E extends Event = Event> = Factory<
    [Ctx],
    EventHandler<E>
>;
