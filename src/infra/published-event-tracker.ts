import { Event } from "Hexai/message";

export interface PublishedEventTracker {
    getUnpublishedEvents(batchSize?: number): Promise<[number, Array<Event>]>;

    markEventsAsPublished(
        fromPosition: number,
        numEvents: number
    ): Promise<void>;
}
