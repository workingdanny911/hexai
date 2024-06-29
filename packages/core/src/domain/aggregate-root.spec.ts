import { beforeEach, describe, test } from "vitest";
import {
    Counter,
    CounterCreated,
    CounterId,
    CounterValueChanged,
    expectMessagesToBeEqual,
} from "@/test";
import { DomainEventPublisher } from "./domain-event-publisher";
import { DomainEvent } from "./domain-event";

class CollectingDomainEventPublisher implements DomainEventPublisher {
    private events: DomainEvent[] = [];

    public publish(event: DomainEvent): void {
        this.events.push(event);
    }

    public getEvents(): DomainEvent[] {
        return this.events;
    }
}

describe("aggregate root", () => {
    let counter: Counter;
    let publisher: CollectingDomainEventPublisher;

    beforeEach(() => {
        publisher = new CollectingDomainEventPublisher();
        counter = Counter.create(new CounterId("counter-id"));
        counter.setDomainEventPublisher(publisher);
    });

    test("raising events", () => {
        counter.increment();

        expectMessagesToBeEqual(publisher.getEvents(), [
            new CounterCreated({ id: counter.getId() }),
            new CounterValueChanged({ id: counter.getId(), value: 1 }),
        ]);
    });
});
