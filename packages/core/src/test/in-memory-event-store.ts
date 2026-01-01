import { EventStore, EventStoreFetchResult, StoredEvent } from "@/event-store";
import { Message } from "@/message";

export class InMemoryEventStore implements EventStore {
    private events: StoredEvent[] = [];

    async store(event: Message): Promise<StoredEvent> {
        const position = this.events.length + 1;
        const storedEvent: StoredEvent = { position, event };
        this.events.push(storedEvent);
        return storedEvent;
    }

    async storeAll(events: Message[]): Promise<StoredEvent[]> {
        const storedEvents: StoredEvent[] = [];
        for (const event of events) {
            storedEvents.push(await this.store(event));
        }
        return storedEvents;
    }

    async fetch(
        afterPosition: number,
        limit?: number
    ): Promise<EventStoreFetchResult> {
        const lastPosition = await this.getLastPosition();
        let filtered = this.events.filter((e) => e.position > afterPosition);

        if (limit !== undefined) {
            filtered = filtered.slice(0, limit);
        }

        return {
            events: filtered,
            lastPosition,
        };
    }

    async getLastPosition(): Promise<number> {
        return this.events.length;
    }

    clear(): void {
        this.events = [];
    }
}
