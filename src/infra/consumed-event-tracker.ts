import { Event } from "Hexai/message";

export interface ConsumedEventTracker {
    markAsConsumed(name: string, event: Event): Promise<void>;
}
