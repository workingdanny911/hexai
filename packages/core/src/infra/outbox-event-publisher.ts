import { Event } from "@/message";

export interface OutboxEventPublisher {
    publish(events: Array<Event>): Promise<void>;
}
