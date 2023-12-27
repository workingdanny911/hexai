import { Event } from "@/message";

export interface ConsumedEventTracker {
    markAsConsumed(name: string, event: Event): Promise<void>;
}
