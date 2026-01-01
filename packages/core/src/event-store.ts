import { Message } from "./message";

export interface StoredEvent {
    position: number;
    event: Message;
}

export interface EventStoreFetchResult {
    events: StoredEvent[];
    lastPosition: number;
}

export interface EventStore {
    fetch(
        afterPosition: number,
        limit?: number
    ): Promise<EventStoreFetchResult>;
}
