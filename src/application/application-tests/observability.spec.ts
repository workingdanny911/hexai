import { beforeEach, describe, expect, test, vi } from "vitest";

import {
    counterApplicationContext,
    DummyEventHandler,
    EchoEventHandler,
    FailingEventHandler,
    prepareCounterApplication,
} from "./application-tests.fixtures";
import {
    CounterApplicationContext,
    CreateCounterRequest,
    createDummyEvents,
    expectEventsToEqual,
    expectUnknownErrorResponse,
    expectValidationErrorResponse,
    IncreaseCounterRequest,
} from "Hexai/test";
import {
    ApplicationBuilder,
    ApplicationEvent,
    CommandExecutionResult,
    ErrorReport,
    EventHandlingResult,
    UseCase,
} from "Hexai/application";
import { Command, Event, Message } from "Hexai/message";

describe("application observability", () => {
    const builder = prepareCounterApplication(
        counterApplicationContext
    ).withUseCase(FailingUseCaseRequest, FailingUseCase);
    let app = builder.build();
    const eventTracker = counterApplicationContext.getEventTracker();
    let commandExecutionResult!: CommandExecutionResult;
    let uncaughtExceptionReport: ErrorReport | undefined;
    let eventHandlingResult!: EventHandlingResult;

    function appListener(info: ApplicationEvent) {
        const [type, result] = info;

        if (type === "command-execution") {
            commandExecutionResult = result;
        } else if (type === "uncaught-exception") {
            uncaughtExceptionReport = result;
        } else if (type === "event-handling") {
            eventHandlingResult = result;
        }
    }

    beforeEach(() => {
        commandExecutionResult = undefined as any;

        app.listen(appListener);
        vi.restoreAllMocks();

        return () => {
            app.removeListener(appListener);
        };
    });

    function expectToBeFailed(command: Command) {
        expect(commandExecutionResult.isError()).toBe(true);
        expect(commandExecutionResult.isSuccessful()).toBe(false);
        expect(commandExecutionResult.getCommand()).toEqual(command);
        expect(commandExecutionResult.getEventsPublished()).toEqual([]);
    }

    function expectToBeSuccessful(
        command: Command,
        response: unknown,
        events: Array<Event>
    ) {
        expect(commandExecutionResult.isError()).toBe(false);
        expect(commandExecutionResult.isSuccessful()).toBe(true);
        expect(commandExecutionResult.getCommand()).toEqual(command);
        expect(commandExecutionResult.getResponse()).toEqual(response);
        expect(commandExecutionResult.getEventsPublished()).toEqual(events);
    }

    function expectUncaughtError(cause: Message, error: Error) {
        expect(uncaughtExceptionReport?.getError()).toEqual(error);
        expect(uncaughtExceptionReport?.occurredDuring()).toBe(
            cause instanceof Command ? "command-execution" : "event-handling"
        );
        expect(uncaughtExceptionReport?.getCause()).toEqual(cause);
    }

    test("observing command execution", async () => {
        const command = new CreateCounterRequest("counter-id");

        const response = await app.execute(command);

        const [, events] = await eventTracker.getUnpublishedEvents();
        expectToBeSuccessful(command, response, events);
    });

    test("when command execution fails", async () => {
        const command = new IncreaseCounterRequest("non-existent");

        const response = await app.execute(command);

        expectValidationErrorResponse(response, {
            id: "NOT_FOUND",
        });
        expectToBeFailed(command);
    });

    test("when command execution throws", async () => {
        const command = new FailingUseCaseRequest();

        const response = await app.execute(command);

        expectUnknownErrorResponse(response, "Something went wrong");
        expectToBeFailed(command);
        expectUncaughtError(command, new Error("Something went wrong"));
    });

    test("observing event handling", async () => {
        const app = new ApplicationBuilder()
            .withContext(counterApplicationContext)
            .withConsumedEventTracker(
                counterApplicationContext.getConsumedEventTracker()
            )
            .withEventHandler(DummyEventHandler)
            .withEventHandler("named-event-handler", DummyEventHandler)
            .withIdempotentEventHandler(
                "idempotent-event-handler",
                DummyEventHandler
            )
            .withEventHandler(
                "event-publishing-event-handler",
                EchoEventHandler
            )
            .build();
        app.listen(appListener);
        const [event] = createDummyEvents();

        await app.handle(event);

        expect(eventHandlingResult.getEvent()).toEqual(event);
        expect(eventHandlingResult.getHandlerExecutionResults()).toEqual([
            {
                handler: {
                    index: 0,
                    name: "anonymous-0",
                    idempotent: false,
                },
            },
            {
                handler: {
                    index: 1,
                    name: "named-event-handler",
                    idempotent: false,
                },
            },
            {
                handler: {
                    index: 2,
                    name: "idempotent-event-handler",
                    idempotent: true,
                },
            },
            {
                handler: {
                    index: 3,
                    name: "event-publishing-event-handler",
                    idempotent: false,
                },
            },
        ]);
        expectEventsToEqual(eventHandlingResult.getEventsPublished(), [event]);
    });

    test("when event handling throws", async () => {
        const app = new ApplicationBuilder()
            .withContext(counterApplicationContext)
            .withConsumedEventTracker(
                counterApplicationContext.getConsumedEventTracker()
            )
            .withEventHandler(FailingEventHandler)
            .build();
        app.listen(appListener);
        const [event] = createDummyEvents();

        await app.handle(event);

        expect(eventHandlingResult.getEvent()).toEqual(event);
        expect(eventHandlingResult.getHandlerExecutionResults()).toEqual([
            {
                handler: {
                    index: 0,
                    name: "anonymous-0",
                    idempotent: false,
                },
                error: new Error("Something went wrong"),
            },
        ]);
        expect(eventHandlingResult.getEventsPublished()).toEqual([]);
        expectUncaughtError(event, new Error("Something went wrong"));
    });
});

class FailingUseCaseRequest extends Command {
    constructor() {
        super({});
    }
}

class FailingUseCase extends UseCase<
    FailingUseCaseRequest,
    void,
    CounterApplicationContext
> {
    public async execute() {
        throw new Error("Something went wrong");
    }

    protected async doExecute() {}
}
