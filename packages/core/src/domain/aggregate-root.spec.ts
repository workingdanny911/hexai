import { beforeEach, describe, test } from "vitest";

import {
    Counter,
    CounterCreated,
    CounterId,
    CounterValueChanged,
    expectMessagesToBeEqual,
} from "@/test";

describe("aggregate root", () => {
    let counter: Counter;

    beforeEach(() => {
        counter = Counter.create(new CounterId("counter-id"));
    });

    test("raising events", () => {
        counter.increment();

        expectMessagesToBeEqual(counter.getEventsOccurred(), [
            new CounterCreated({ id: counter.getId() }),
            new CounterValueChanged({ id: counter.getId(), value: 1 }),
        ]);
    });
});
