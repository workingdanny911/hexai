import { beforeEach, describe, expect, it, test, vi } from "vitest";

import {
    CounterApplicationContext,
    CounterId,
    CreateCounter,
    CreateCounterRequest,
    createDummyEvents,
} from "Hexai/test";
import { Event } from "Hexai/message";
import { ApplicationBuilder, EventHandler } from "Hexai/application";

import {
    consumedEventTracker,
    counterApplicationContext,
    counterRepository,
    expectEventConsumed,
    expectEventNotConsumed,
    FailingEventHandler,
} from "./application-tests.fixtures";

class EventHandlerSpy implements EventHandler {
    public static eventsHandled: Event[] = [];

    constructor(private ctx: CounterApplicationContext) {}

    public static reset() {
        this.eventsHandled = [];
    }

    public async handle(event: Event): Promise<void> {
        EventHandlerSpy.eventsHandled.push(event);
    }
}

class TimeTakingEventHandler {
    constructor(
        private timeout: number,
        private ctx: CounterApplicationContext
    ) {}

    public async handle(event: Event): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, this.timeout));
    }
}

describe("event handling", () => {
    const [event] = createDummyEvents();
    let builder: ApplicationBuilder;

    beforeEach(() => {
        builder = new ApplicationBuilder()
            .withContext(counterApplicationContext)
            .withConsumedEventTracker(consumedEventTracker);

        EventHandlerSpy.reset();

        vi.restoreAllMocks();
    });

    it.each([null, undefined, 1, "string", {}, () => {}, class {}])(
        "only accept events",
        async (notAnEvent) => {
            await expect(
                // @ts-expect-error: only accept events
                builder.build().handle(notAnEvent)
            ).rejects.toThrowError(/.*must be an instance of 'Event'.*/);
        }
    );

    test("with single event handler", async () => {
        const app = builder.withEventHandler(EventHandlerSpy).build();

        await app.handle(event);

        expect(EventHandlerSpy.eventsHandled).toEqual([event]);
    });

    test("with multiple event handlers", async () => {
        const app = builder
            .withEventHandler(EventHandlerSpy)
            .withEventHandler(EventHandlerSpy)
            .build();

        await app.handle(event);

        expect(EventHandlerSpy.eventsHandled).toEqual([event, event]);
    });

    test("multiple events handlers are run concurrently", async () => {
        const timeout = 100;
        const jitter = 10;
        const app = builder
            .withEventHandler((ctx) => new TimeTakingEventHandler(timeout, ctx))
            .withEventHandler((ctx) => new TimeTakingEventHandler(timeout, ctx))
            .build();

        const timeBefore = Date.now();
        await app.handle(event);
        const timeAfter = Date.now();

        expect(timeAfter - timeBefore).toBeLessThan(timeout + jitter);
    });

    test("all of the event handlers are run to completion even if one of them fails", async () => {
        const app = builder
            .withEventHandler(EventHandlerSpy)
            .withEventHandler(FailingEventHandler)
            .withEventHandler(EventHandlerSpy)
            .build();

        await app.handle(event);

        expect(EventHandlerSpy.eventsHandled).toEqual([event, event]);
    });

    test("idempotent event handler", async () => {
        let i = 0;
        function createCounterFactory(ctx: CounterApplicationContext) {
            return {
                async handle() {
                    await new CreateCounter(ctx).execute(
                        new CreateCounterRequest(`counter-${i++}`)
                    );
                },
            };
        }

        const app = builder
            .withIdempotentEventHandler("create-counter", createCounterFactory)
            .build();

        await app.handle(event);
        await expectEventConsumed("create-counter", event);

        await app.handle(event);
        await expect(counterRepository.count()).resolves.toEqual(1);
    });

    test("when handling fails, the event is not marked as consumed", async () => {
        const app = builder
            .withIdempotentEventHandler("event-handler", () => ({
                async handle() {
                    throw new Error("event handler failed");
                },
            }))
            .build();

        await app.handle(event);

        await expectEventNotConsumed("event-handler", event);
    });

    test("each idempotent event handler is run in a separate transaction", async () => {
        const app = builder
            .withIdempotentEventHandler("create-counter", (ctx) => ({
                async handle() {
                    await new CreateCounter(ctx).execute(
                        new CreateCounterRequest("counter")
                    );
                },
            }))
            .withIdempotentEventHandler(
                "failing-event-handler",
                FailingEventHandler
            )
            .build();

        await app.handle(event);

        await expect(
            counterRepository.get(CounterId.from("counter"))
        ).resolves.toBeDefined();

        await expectEventConsumed("create-counter", event);
        await expectEventNotConsumed("failing-event-handler", event);
    });
});
