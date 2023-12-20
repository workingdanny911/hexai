import { beforeEach, describe, expect, test } from "vitest";
import {
    Counter,
    CounterCreated,
    CounterId,
    CounterValueChanged,
    expectEventsToEqual,
} from "Hexai/test";

describe("aggregate root", () => {
    let counter: Counter;

    beforeEach(() => {
        counter = Counter.create(CounterId.from("counter-id"));
    });

    test("raising events", () => {
        counter.increment();

        expectEventsToEqual(counter.collectEvents(), [
            new CounterCreated({ id: counter.getId() }),
            new CounterValueChanged({ id: counter.getId(), value: 1 }),
        ]);
    });

    test("events are cleared after collection", () => {
        counter.increment();

        counter.collectEvents();

        expect(counter.collectEvents()).toHaveLength(0);
    });
});
