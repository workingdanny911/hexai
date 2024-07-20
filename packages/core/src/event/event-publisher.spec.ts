import { beforeEach, describe, expect, test, vi } from "vitest";

import { Event } from "./event";
import { EventPublisher } from "./event-publisher";

describe("application event publisher", () => {
    let publisher: EventPublisher<Event<string, null>>;
    const subscriber = vi.fn();

    beforeEach(() => {
        publisher = new EventPublisher();

        vi.resetAllMocks();
    });

    async function publish(...types: string[]) {
        const events = types.map((type, i) => ({
            type,
            payload: null,
            occurredAt: new Date(),
        }));
        await publisher.publish(...events);
    }

    test("subscribing", async () => {
        publisher.subscribe(subscriber);

        await publish("test-1");
        await publish("test-2");

        expect(subscriber.mock.calls).toMatchObject([
            [{ type: "test-1" }],
            [{ type: "test-2" }],
        ]);
    });

    test("subscribing twice", async () => {
        publisher.subscribe(subscriber);
        publisher.subscribe(subscriber);

        await publish("test-1");

        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    async function wait(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("callbacks run event by event", async () => {
        publisher.subscribe(() => wait(50));

        const tStart = Date.now();
        await publish("test-1");
        await publish("test-2");
        const tEnd = Date.now();

        expect(tEnd - tStart).toBeGreaterThanOrEqual(50 * 2);
    });

    test("publishing fails when subscriber throws", async () => {
        publisher.subscribe(() => {
            throw new Error("error!");
        });

        const publishing = () => publish("test");
        await expect(publishing).rejects.toThrowError("error!");
    });

    test("unsubscribing", async () => {
        const subscriber2 = vi.fn();
        const unsubscribe = publisher.subscribe(subscriber);
        publisher.subscribe(subscriber2);
        await publish("test-1");

        unsubscribe();

        await publish("test-2");
        expect(subscriber).toHaveBeenCalledTimes(1);
        expect(subscriber2).toHaveBeenCalledTimes(2);
    });
});
