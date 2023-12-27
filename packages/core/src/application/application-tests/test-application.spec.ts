import { beforeEach, describe, expect, test } from "vitest";
import { ApplicationBuilder } from "@/application";
import {
    counterApplicationContext,
    FailingEventHandler,
    IncreaseValueWhenCounterCreated,
    setUpCounter,
} from "@/application/application-tests/application-tests.fixtures";
import {
    CounterCreated,
    CounterId,
    CounterValueChanged,
    CreateCounter,
    CreateCounterRequest,
    expectEventsPublishedToEqual,
    expectNoEventsPublished,
} from "@/test";
import { TestApplication } from "@/application/test-application";

describe("test application", () => {
    const builder = new ApplicationBuilder()
        .withApplicationClass(TestApplication)
        .withContext(counterApplicationContext)
        .withUseCase(CreateCounterRequest, CreateCounter)
        .withEventHandler("increase-after-some-time", (ctx) => ({
            async handle(event: CounterCreated): Promise<void> {
                await new Promise((resolve) => setTimeout(resolve, 100));
                await new IncreaseValueWhenCounterCreated(ctx).handle(event);
            },
        }));
    let app = builder.build();
    const counterRepository = counterApplicationContext.getCounterRepository();
    const eventTracker = counterApplicationContext.getPublishedEventTracker();

    beforeEach(() => {
        app = builder.build();
    });

    test("event handlers are run to completion before returning from .execute()", async () => {
        const app = builder.build();

        await app.execute(new CreateCounterRequest("counter-id"));

        const counter = await counterRepository.get(
            CounterId.from("counter-id")
        );
        expect(counter.getValue()).toBe(1);

        await expectEventsPublishedToEqual(eventTracker, [
            new CounterCreated({
                id: CounterId.from("counter-id"),
            }),
            new CounterValueChanged({
                id: CounterId.from("counter-id"),
                value: 1,
            }),
        ]);
    });

    test("event handlers are run to completion before returning from .handle()", async () => {
        const counterCreated = await setUpCounter();

        await app.handle(counterCreated);

        const counter = await counterRepository.get(
            counterCreated.getPayload().id
        );
        expect(counter.getValue()).toBe(1);

        await expectEventsPublishedToEqual(eventTracker, [
            new CounterValueChanged({
                id: counterCreated.getPayload().id,
                value: 1,
            }),
        ]);
    });

    test("all events handlers are run in the same transaction started in .execute()", async () => {
        app = builder.withEventHandler(FailingEventHandler).build();

        await app.execute(new CreateCounterRequest("counter-id"));

        await expect(counterRepository.count()).resolves.toEqual(0);
        await expectNoEventsPublished(eventTracker);
    });

    test("all event handlers are run in the same transaction started in .handle()", async () => {
        app = builder.withEventHandler(FailingEventHandler).build();
        const counterCreated = await setUpCounter();

        await app.handle(counterCreated);

        const counter = await counterRepository.get(
            counterCreated.getPayload().id
        );
        expect(counter.getValue()).toBe(0);
        await expectNoEventsPublished(eventTracker);
    });
});
