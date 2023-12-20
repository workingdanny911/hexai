import { Event } from "Hexai/message";

export default interface EventPublisher {
    publish(events: Array<Event>): Promise<void>;
}
