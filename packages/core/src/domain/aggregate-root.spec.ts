import { describe, expect, test } from "vitest";

import { AggregateRoot } from "./aggregate-root";
import { DomainEvent } from "./domain-event";
import { Id } from "./identifiable";

class TestId extends Id<string> {}

class TestEvent extends DomainEvent<{ id: TestId }> {
    public static type = "test.event";
}

class TestAggregate extends AggregateRoot<TestId> {
    public doSomething(): void {
        this.raise(new TestEvent({ id: this.getId() }));
    }
}

describe("aggregate root", () => {
    test("raising events", () => {
        const id = new TestId("test-id");
        const aggregate = new TestAggregate(id);

        aggregate.doSomething();

        const events = aggregate.getEventsOccurred();
        expect(events).toHaveLength(1);
        expect(events[0]).toBeInstanceOf(TestEvent);
    });
});
