import { beforeEach, describe, expect, test } from "vitest";
import {
    CounterCreated,
    CounterId,
    CounterValueChanged,
    CreateCounterRequest,
    createDummyEvents,
    expectEventsPublishedToContain,
    expectEventsPublishedToEqual,
    waitForSeveralTicks,
} from "Hexai/test";
import { Message } from "Hexai/message";
import {
    counterApplicationContext,
    counterRepository,
    EchoEventHandler,
    FailingEventHandler,
    prepareCounterApplication,
    setUpCounter,
} from "./application-tests.fixtures";

describe("event publishing", () => {
    let builder = prepareCounterApplication(counterApplicationContext);
    let app = builder.build();
    const eventTracker = counterApplicationContext.getPublishedEventTracker();

    beforeEach(async () => {
        app = builder.build();
        // because event handlers are run asynchronously,
        // wait for event handlers fired in previous app to finish execution
        await waitForSeveralTicks();
    });

    async function expectCauseToBe(message: Message): Promise<void> {
        const [_, events] = await eventTracker.getUnpublishedEvents();
        expect(events.length).toBeGreaterThan(0);

        for (const event of events) {
            expect(event.getCausation()).toEqual({
                id: message.getMessageId(),
                type: message.getMessageType(),
            });
        }
    }

    async function expectCorrelationToBe(message: Message): Promise<void> {
        const [_, events] = await eventTracker.getUnpublishedEvents();
        expect(events.length).toBeGreaterThan(0);

        for (const event of events) {
            expect(event.getCorrelation()).toEqual({
                id: message.getMessageId(),
                type: message.getMessageType(),
            });
        }
    }

    test("setting cause when executing command", async () => {
        const command = new CreateCounterRequest("counter-id");

        await app.execute(command);

        await expectCauseToBe(command);
    });

    test("setting cause when handling event", async () => {
        const counterCreated = await setUpCounter();

        await app.handle(counterCreated);

        await expectCauseToBe(counterCreated);
    });

    test("when correlation is not set on the command", async () => {
        const command = new CreateCounterRequest("counter-id");

        await app.execute(command);

        await expectCorrelationToBe(command);
    });

    test("when correlation is set on the command", async () => {
        const [dummyMessage] = createDummyEvents();
        const command = new CreateCounterRequest("counter-id");
        command.setCause(dummyMessage);

        await app.execute(command);

        await expectCorrelationToBe(dummyMessage);
    });

    test("when correlation is set on the event", async () => {
        const [dummyMessage] = createDummyEvents();
        const counterCreated = await setUpCounter();
        counterCreated.setCause(dummyMessage);

        await app.handle(counterCreated);

        await expectCorrelationToBe(dummyMessage);
    });

    test("handling events occurred during command execution", async () => {
        const counterId = CounterId.from("counter-id");

        await app.execute(new CreateCounterRequest("counter-id"));

        await waitForSeveralTicks();
        const counter = await counterRepository.get(counterId);
        expect(counter.getValue()).toBe(1);

        await expectEventsPublishedToEqual(eventTracker, [
            new CounterCreated({ id: counterId }),
            new CounterValueChanged({ id: counterId, value: 1 }),
        ]);
    });

    test("handling events occurred during event handling", async () => {
        const [dummyEvent] = createDummyEvents();
        app = builder
            .withEventHandler("echo", (ctx) => new EchoEventHandler(ctx, 2))
            .build();

        await app.handle(dummyEvent);

        await waitForSeveralTicks();
        // echo twice
        await expectEventsPublishedToEqual(eventTracker, createDummyEvents(2));
    });

    test("failure of internal event handling does not affect command execution or event publishing", async () => {
        app = builder.withEventHandler(FailingEventHandler).build();
        const counterId = CounterId.from("counter-id");
        await expect(counterRepository.count()).resolves.toBe(0);

        await app.execute(new CreateCounterRequest(counterId.getValue()));

        await expect(counterRepository.count()).resolves.toBe(1);
        await expectEventsPublishedToContain(eventTracker, [
            new CounterCreated({ id: counterId }),
        ]);
    });
});
