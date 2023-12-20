import { Event } from "Hexai/message";

export default interface ConsumedEventTracker {
    markAsConsumed(name: string, event: Event): Promise<void>;
}
