import { beforeEach, describe, expect, test } from "vitest";

import { Counter, CounterId } from "@/test";

describe("aggregate root", () => {
    const counterId = new CounterId("counter-id");
    let counter: Counter;

    beforeEach(() => {
        counter = Counter.create(counterId);
    });

    test("raising events", () => {
        counter.increment();

        expect(counter.getEventsOccurred()).toEqual([
            {
                type: "counter.created",
                payload: { counterId: "counter-id" },
                occurredAt: expect.any(Date),
            },
            {
                type: "counter.value-changed",
                payload: { counterId: "counter-id", value: 1 },
                occurredAt: expect.any(Date),
            },
        ]);
    });
});
