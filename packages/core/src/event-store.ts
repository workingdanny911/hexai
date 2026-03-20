import { Message } from "./message.js";

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
    stream?(
        afterPosition: number,
        batchSize: number
    ): AsyncGenerator<StoredEvent>;
    getEventCount?(afterPosition: number): Promise<number>;
}
