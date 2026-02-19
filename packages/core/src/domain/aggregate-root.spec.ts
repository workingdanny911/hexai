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

    describe("flushEvents", () => {
        test("returns empty array when no events raised", () => {
            const aggregate = new TestAggregate(new TestId("agg-1"));

            expect(aggregate.flushEvents()).toEqual([]);
        });

        test("returns raised events", () => {
            const aggregate = new TestAggregate(new TestId("agg-1"));
            aggregate.doSomething();

            const flushed = aggregate.flushEvents();

            expect(flushed).toHaveLength(1);
            expect(flushed[0]).toBeInstanceOf(TestEvent);
        });

        test("clears internal events after flush", () => {
            const aggregate = new TestAggregate(new TestId("agg-1"));
            aggregate.doSomething();
            aggregate.doSomething();

            aggregate.flushEvents();

            expect(aggregate.getEventsOccurred()).toEqual([]);
            expect(aggregate.flushEvents()).toEqual([]);
        });

        test("does not affect previously flushed array", () => {
            const aggregate = new TestAggregate(new TestId("agg-1"));
            aggregate.doSomething();

            const firstFlush = aggregate.flushEvents();
            aggregate.doSomething();

            expect(firstFlush).toHaveLength(1);
            expect(aggregate.flushEvents()).toHaveLength(1);
        });
    });

    describe("getEventsOccurred", () => {
        test("returns shallow copy without clearing", () => {
            const aggregate = new TestAggregate(new TestId("agg-1"));
            aggregate.doSomething();

            const first = aggregate.getEventsOccurred();
            const second = aggregate.getEventsOccurred();

            expect(first).toEqual(second);
            expect(first).not.toBe(second);
            expect(first).toHaveLength(1);
        });
    });
});
