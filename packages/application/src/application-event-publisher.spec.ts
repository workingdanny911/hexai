import { beforeEach, describe, expect, Mock, test, vi } from "vitest";

import { Message } from "@hexaijs/core";
import { DummyMessage } from "@hexaijs/core/test";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { asTrace, MessageTrace } from "./messaging-support";

describe("application event publisher", () => {
    let publisher: ApplicationEventPublisher;
    let subscriber: Mock;
    const [event1, event2] = DummyMessage.createMany(2);

    beforeEach(() => {
        publisher = new ApplicationEventPublisher();
        subscriber = vi.fn();
    });

    test("subscribing", async () => {
        publisher.subscribe(subscriber);

        await publisher.publish(event1);
        await publisher.publish(event2);

        expect(subscriber.mock.calls).toEqual([[event1], [event2]]);
    });

    test("subscribing twice", async () => {
        publisher.subscribe(subscriber);
        publisher.subscribe(subscriber);

        await publisher.publish(event1);

        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    async function wait(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("callbacks run event by event", async () => {
        publisher.subscribe(() => wait(50));

        const tStart = Date.now();
        await publisher.publish(event1);
        await publisher.publish(event2);
        const tEnd = Date.now();

        expect(tEnd - tStart).toBeGreaterThanOrEqual(50 * 2);
    });

    test("publishing fails when subscriber throws", async () => {
        publisher.subscribe(() => {
            throw new Error("test");
        });

        await expect(publisher.publish(event1)).rejects.toThrowError("test");
    });

    test("unsubscribing", async () => {
        const subscriber2 = vi.fn();

        const unsubscribe = publisher.subscribe(subscriber);
        publisher.subscribe(subscriber2);

        await publisher.publish(event1);

        unsubscribe();

        await publisher.publish(event2);

        expect(subscriber).toHaveBeenCalledTimes(1);
        expect(subscriber2).toHaveBeenCalledTimes(2);
    });

    test("publishing multiple events", async () => {
        publisher.subscribe(subscriber);

        await publisher.publish(event1, event2);

        expect(subscriber.mock.calls).toEqual([[event1], [event2]]);
    });

    function expectMetadata(
        event: Message,
        {
            correlation,
            causation,
        }: {
            correlation?: MessageTrace;
            causation?: MessageTrace;
        }
    ) {
        if (correlation) {
            expect(event.getHeader("correlation")).toEqual(correlation);
        }

        if (causation) {
            expect(event.getHeader("causation")).toEqual(causation);
        }
    }

    test("derived instance adds correlation & causation metadata to publishing events", async () => {
        const message = DummyMessage.create();
        const derivative = publisher.deriveFrom(message);
        subscriber.mockImplementation((event) => {
            const trace = asTrace(message);
            expectMetadata(event, {
                correlation: trace,
                causation: trace,
            });
        });
        derivative.subscribe(subscriber);

        await derivative.publish(event1);

        expect(subscriber).toBeCalled();
    });

    test("deriving a new instance does not affect parent, metadata-wise", async () => {
        subscriber.mockImplementation((event) => {
            expect(event.getHeader("correlation")).toBeUndefined();
            expect(event.getHeader("causation")).toBeUndefined();
        });
        publisher.subscribe(subscriber);

        const derivative = publisher.deriveFrom(DummyMessage.create());
        expect(derivative).not.toBe(publisher);

        await publisher.publish(event1);

        expect(subscriber).toBeCalled();
    });

    test("callbacks are preserved when deriving, but does not execute callbacks multiple times", async () => {
        subscriber.mockImplementation((event) => {
            // if callbacks were executed in parent too, these would be undefined
            expect(event.getHeader("correlation")).toBeDefined();
            expect(event.getHeader("causation")).toBeDefined();
        });
        publisher.subscribe(subscriber);
        const derivative = publisher.deriveFrom(DummyMessage.create());

        await derivative.publish(event1);

        expect(subscriber).toBeCalledTimes(1);
    });

    test("adding callbacks to derived instance does not affect parent", async () => {
        const derivative = publisher.deriveFrom(DummyMessage.create());
        derivative.subscribe(subscriber);

        await publisher.publish(event1);

        expect(subscriber).not.toBeCalled();
    });

    test("reserves correlation of the message that the event publisher is deriving from", async () => {
        // root -> child -> event1
        const root = DummyMessage.create();
        const child = DummyMessage.create().withHeader(
            "correlation",
            asTrace(root)
        );
        const derivative = publisher.deriveFrom(child);
        subscriber.mockImplementation((event) => {
            expect(event.getHeader("correlation")).toEqual(asTrace(root));
            expect(event.getHeader("causation")).toEqual(asTrace(child));
        });
        derivative.subscribe(subscriber);

        await derivative.publish(event1);

        expect(subscriber).toBeCalled();
    });
});
