import { Message } from "@/message";

export interface ConsumedMessageTracker {
    markAsConsumed(name: string, message: Message): Promise<void>;
}
