import { Event } from "Hexai/message";

export interface OutboxEventPublisher {
    publish(events: Array<Event>): Promise<void>;
}
