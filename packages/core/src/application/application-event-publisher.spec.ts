import { beforeEach, describe, expect, test, vi } from "vitest";

import { ApplicationEventPublisher } from "./application-event-publisher";
import { waitForMs } from "@/utils";
import { DomainEvent } from "@/domain";

class FooEvent extends DomainEvent {}

describe("application event publisher", () => {
    let publisher: ApplicationEventPublisher;
    const subscriber = vi.fn();

    beforeEach(() => {
        publisher = new ApplicationEventPublisher();

        vi.resetAllMocks();
    });

    test("subscribing", async () => {
        publisher.onPublish(subscriber);

        await publisher.publish({
            type: "test-1",
        });
        await publisher.publish({
            type: "test-2",
        });

        expect(subscriber.mock.calls).toEqual([
            [{ type: "test-1" }, null],
            [{ type: "test-2" }, null],
        ]);
    });

    test("subscribing twice", async () => {
        publisher.onPublish(subscriber);
        publisher.onPublish(subscriber);

        await publisher.publish({
            type: "test-1",
        });

        expect(subscriber).toHaveBeenCalledTimes(1);
    });

    async function wait(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    test("callbacks run event by event", async () => {
        publisher.onPublish(() => wait(50));

        const tStart = Date.now();
        await publisher.publish({
            type: "test-1",
        });
        await publisher.publish({
            type: "test-2",
        });
        const tEnd = Date.now();

        expect(tEnd - tStart).toBeGreaterThanOrEqual(50 * 2);
    });

    test("context", async () => {
        publisher.onPublish(subscriber);

        await publisher.bindContext({ foo: "bar" }, async () => {
            await publisher.publish({
                type: "test",
            });
        });

        expect(subscriber).toHaveBeenCalledWith(
            { type: "test" },
            { foo: "bar" }
        );
    });

    test("publishing fails when subscriber throws", async () => {
        publisher.onPublish(() => {
            throw new Error("test");
        });

        await expect(
            publisher.publish({
                type: "test",
            })
        ).rejects.toThrowError("test");
    });

    test("unsubscribing", async () => {
        const subscriber2 = vi.fn();

        const unsubscribe = publisher.onPublish(subscriber);
        publisher.onPublish(subscriber2);

        await publisher.publish({
            type: "test-1",
        });

        unsubscribe();

        await publisher.publish({
            type: "test-2",
        });

        expect(subscriber).toHaveBeenCalledTimes(1);
        expect(subscriber2).toHaveBeenCalledTimes(2);
    });
});
