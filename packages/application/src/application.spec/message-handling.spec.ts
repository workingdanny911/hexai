import { beforeEach, describe, expect, test, vi } from "vitest";
import { Message } from "@hexaijs/core";
import { waitForMs } from "@hexaijs/core/test";

import { AbstractApplicationContext } from "@/abstract-application-context";
import { Command } from "@/command";
import { ApplicationError, ApplicationErrorTransformingContext } from "@/error";
import { ApplicationBuilder, SuccessResult } from "@/application";
import { MessageHandler } from "@/message-handler";
import {
    DummyCommand,
    DummyEvent,
    expectApplicationError,
    expectExecutionTimeLessThan,
    expectSuccessResult,
} from "@/test";

describe("Application, handling message", () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    const commandHandlerMock = {
        execute: vi.fn(),
    };

    class TestApplicationContext extends AbstractApplicationContext {
        public lastCommand: Command | null = null;

        protected async onEnter(message: Message): Promise<void> {
            await super.onEnter(message);
            this.lastCommand = message as Command;
        }
    }

    let applicationContext: TestApplicationContext;

    let sutBuilder: ApplicationBuilder;
    const defaultSecurityContext = { role: "TEST" };
    const command = new DummyCommand(defaultSecurityContext);
    const event = new DummyEvent();

    beforeEach(() => {
        applicationContext = new TestApplicationContext();
        sutBuilder = new ApplicationBuilder().withApplicationContext(
            applicationContext
        );
    });

    test.each([
        new SuccessResult({ foo: "bar" }),
        new SuccessResult({ foo: "baz" }),
    ])(
        "dispatches command to matching command handler",
        async (executionResult) => {
            commandHandlerMock.execute.mockResolvedValue(executionResult);
            const application = sutBuilder
                .withCommandHandler(DummyCommand, () => commandHandlerMock)
                .build();

            const result = await application.executeCommand(command);

            expectSuccessResult(result);
            expect(result.data).toBe(executionResult);
        }
    );

    test("enters message scope of the application context and injects it to the command handler", async () => {
        const commandHandlerSpy: {
            execute(
                request: Message,
                ctx?: TestApplicationContext
            ): Promise<string>;
        } = {
            async execute(request: any, ctx?: TestApplicationContext) {
                expect(ctx).toBeInstanceOf(TestApplicationContext);
                expect(ctx!.lastCommand).toBe(request);
                return "ok";
            },
        };

        const result = await sutBuilder
            .withCommandHandler(DummyCommand, () => commandHandlerSpy)
            .build()
            .executeCommand(command);

        expectSuccessResult(result);
        expect(result.data).toBe("ok");
    });

    test("if command handler class is registered, creates new command handler everytime before dispatching command", async () => {
        class CommandHandlerSpyWithId implements MessageHandler {
            static id = 0;
            private myId: number;

            constructor() {
                this.myId = ++CommandHandlerSpyWithId.id;
            }

            public async execute(
                command: DummyCommand,
                ctx?: TestApplicationContext
            ): Promise<string> {
                expect(ctx).toBeInstanceOf(TestApplicationContext);
                return `handled by ${this.myId}`;
            }
        }

        const sut = sutBuilder
            .withCommandHandler(
                DummyCommand,
                () => new CommandHandlerSpyWithId()
            )
            .build();

        const handle = async () => {
            const result = await sut.executeCommand(new DummyCommand());
            expectSuccessResult(result);
            return result.data;
        };

        await expect(handle()).resolves.toBe("handled by 1");
        await expect(handle()).resolves.toBe("handled by 2");
    });

    test("without matching command handler, returns ApplicationError", async () => {
        const result = await sutBuilder.build().executeCommand(command);

        expectApplicationError(result);
    });

    test("transforms error thrown in command handler", async () => {
        const error = new Error("some error");
        commandHandlerMock.execute.mockRejectedValue(error);
        const application = sutBuilder
            .withErrorTransformer(
                (
                    error: Error,
                    context: ApplicationErrorTransformingContext
                ) => {
                    return new ApplicationError({
                        data: { error: "data" },
                        message: "message",
                        cause: error,
                    });
                }
            )
            .withCommandHandler(DummyCommand, () => commandHandlerMock)
            .build();

        const result = await application.executeCommand(command);

        expectApplicationError(result, {
            message: "message",
            cause: error,
        });
    });

    test("does not transform ApplicationError thrown in command handler", async () => {
        const originalError = new ApplicationError({
            message: "original message",
            data: { originalData: "value" },
        });
        commandHandlerMock.execute.mockRejectedValue(originalError);
        const errorTransformer = vi.fn();
        const application = sutBuilder
            .withErrorTransformer(errorTransformer)
            .withCommandHandler(DummyCommand, () => commandHandlerMock)
            .build();

        const result = await application.executeCommand(command);

        expect(errorTransformer).not.toHaveBeenCalled();
        expectApplicationError(result, {
            message: "original message",
        });
    });

    function createEventHandlerMock({
        id,
        handle,
        canHandle,
    }: Partial<{
        id: string;
        canHandle: boolean | ((message: Message) => boolean);
        handle: (...args: any[]) => void;
    }> = {}) {
        return {
            getId: vi.fn().mockImplementation(() => id ?? "event-handler-id"),
            handle: vi.fn().mockImplementation(handle ?? (() => {})),
            canHandle: vi.fn().mockImplementation((message: Message) => {
                if (canHandle === undefined) {
                    return true;
                }

                if (typeof canHandle === "function") {
                    return canHandle(message);
                } else {
                    return canHandle;
                }
            }),
        };
    }

    test("dispatches event to event handlers that can handle the event", async () => {
        const eventHandler = createEventHandlerMock();
        const application = sutBuilder
            .withEventHandler(() => eventHandler)
            .build();

        await application.handleEvent(event);

        expect(eventHandler.handle).toBeCalledWith(event, expect.anything());
    });

    test("does not dispatch event to event handlers those cannot handle the event", async () => {
        const eventHandlerThatCanHandle = createEventHandlerMock();
        const eventHandlerThatCannotHandle = createEventHandlerMock({
            id: "event-handler-that-cannot-handle",
            canHandle: false,
        });

        const application = sutBuilder
            .withEventHandler(() => eventHandlerThatCanHandle)
            .withEventHandler(() => eventHandlerThatCannotHandle)
            .build();

        await application.handleEvent(event);

        expect(eventHandlerThatCanHandle.handle).toBeCalled();
        expect(eventHandlerThatCannotHandle.handle).not.toBeCalled();
    });

    test("event handlers are run concurrently", async () => {
        const handlingTime = 100;
        const timeTakingHandle = () => waitForMs(handlingTime);
        const eventHandler1 = createEventHandlerMock({
            id: "event-handler-1",
            handle: timeTakingHandle,
        });
        const eventHandler2 = createEventHandlerMock({
            id: "event-handler-2",
            handle: timeTakingHandle,
        });

        const application = sutBuilder
            .withEventHandler(() => eventHandler1)
            .withEventHandler(() => eventHandler2)
            .build();

        await expectExecutionTimeLessThan(
            () => application.handleEvent(event),
            handlingTime + 10 // 10 is the jitter
        );
    });

    test("event handling is fail-fast", async () => {
        let eventHandlerCompletedExecution = false;
        const failingEventHandler = createEventHandlerMock({
            id: "event-handler-id-1",
            handle: () => {
                throw new Error("failure!");
            },
        });
        const eventHandler = createEventHandlerMock({
            id: "event-handler-id-2",
            handle: () =>
                process.nextTick(() => {
                    eventHandlerCompletedExecution = true;
                }),
        });

        await sutBuilder
            .withEventHandler(() => failingEventHandler)
            .withEventHandler(() => eventHandler)
            .build()
            .handleEvent(event);

        expect(eventHandlerCompletedExecution).toBe(false);
    });

    test("transforms error thrown in event handler", async () => {
        const error = new Error("failure!");
        const failingEventHandler = createEventHandlerMock({
            handle: () => {
                throw error;
            },
        });

        const application = sutBuilder
            .withErrorTransformer(
                (error: Error) =>
                    new ApplicationError({
                        data: { error: "data" },
                        message: "message",
                        cause: error,
                    })
            )
            .withEventHandler(() => failingEventHandler)
            .build();

        const result = await application.handleEvent(event);

        expectApplicationError(result, {
            message: "message",
            cause: error,
        });
    });

    test("does not transform ApplicationError thrown in event handler", async () => {
        const originalError = new ApplicationError({
            message: "original event error",
            data: { originalData: "event value" },
        });
        const failingEventHandler = createEventHandlerMock({
            handle: () => {
                throw originalError;
            },
        });
        const errorTransformer = vi.fn();
        const application = sutBuilder
            .withErrorTransformer(errorTransformer)
            .withEventHandler(() => failingEventHandler)
            .build();

        const result = await application.handleEvent(event);

        expect(errorTransformer).not.toHaveBeenCalled();
        expectApplicationError(result, {
            message: "original event error",
        });
    });

    test.todo("handling errors outside of handler");

    test.todo("returns event handling result");

    test.todo(
        "passing in application error transforming context to error transformer"
    );
});
