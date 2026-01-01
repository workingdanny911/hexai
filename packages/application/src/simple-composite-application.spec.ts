import { beforeEach, describe, expect, test, vi } from "vitest";
import { UnitOfWork } from "@hexaijs/core";
import { waitForMs, waitForTicks } from "@hexaijs/core/test";

import { Application, ErrorResult, Result, SuccessResult } from "@/application";
import { InterceptedApplication } from "@/intercepted-application";
import { ApplicationError } from "@/error";
import { CommandInterceptor, EventInterceptor } from "@/interceptor";
import {
    createCommandExecutionTrackingInterceptor,
    createEventExecutionTrackingInterceptor,
    DummyCommand,
    DummyEvent,
    expectApplicationError,
    expectExecutionTimeLessThan,
} from "@/test";
import { SimpleCompositeApplication } from "./simple-composite-application";

function createMockUnitOfWork(): UnitOfWork<void, never> & {
    wrapSpy: ReturnType<typeof vi.fn>;
} {
    const wrapSpy = vi.fn();
    return {
        getClient: () => null,
        wrap: async <T>(fn: () => Promise<T>): Promise<T> => {
            wrapSpy();
            return fn();
        },
        wrapSpy,
    };
}

function createDummyCommandClass(type: string) {
    return class extends DummyCommand {
        public static type = type;
    };
}

function createDummyEventClass(type: string) {
    return class extends DummyEvent {
        public static type = type;
    };
}

const FooCommand = createDummyCommandClass("foo.command");
const BarCommand = createDummyCommandClass("bar-ctx.command");
const FooEvent = createDummyEventClass("foo.event");

describe("SimpleCompositeApplication", () => {
    beforeEach(() => {});
    const event = new FooEvent();

    function createApplicationMock({
        executeCommand,
        executeQuery,
        handleEvent,
        commandResult,
        queryResult,
        eventResult,
    }: Partial<{
        executeCommand: (...args: any[]) => Promise<any>;
        executeQuery: (...args: any[]) => Promise<any>;
        handleEvent: (...args: any[]) => Promise<any>;
        commandResult: Result<any>;
        queryResult: Result<any>;
        eventResult: Result<any>;
    }> = {}) {
        const defaultExecuteCommand = async () =>
            commandResult ?? new SuccessResult(undefined);
        const defaultExecuteQuery = async () =>
            queryResult ?? new SuccessResult(null);
        const defaultHandleEvent = async () =>
            eventResult ?? new SuccessResult(undefined);

        return {
            executeCommand: vi
                .fn()
                .mockImplementation(executeCommand ?? defaultExecuteCommand),
            executeQuery: vi
                .fn()
                .mockImplementation(executeQuery ?? defaultExecuteQuery),
            handleEvent: vi
                .fn()
                .mockImplementation(handleEvent ?? defaultHandleEvent),
        };
    }

    test("handling command, routes the command to matching application based on prefix of the command type", async () => {
        const resultOfFoo = new SuccessResult("foo result");
        const resultOfBar = new SuccessResult("bar result");
        const fooApplication: Application = createApplicationMock({
            commandResult: resultOfFoo,
        });
        const barApplication: Application = createApplicationMock({
            commandResult: resultOfBar,
        });
        const fooCommand = new FooCommand();
        const barCommand = new BarCommand();

        const sut = new SimpleCompositeApplication({
            foo: fooApplication,
            bar: barApplication,
        });

        let result = await sut.executeCommand(fooCommand);
        expect(fooApplication.executeCommand).toBeCalledWith(fooCommand);
        expect(barApplication.executeCommand).not.toBeCalled();
        expect(result).toBe(resultOfFoo);

        vi.clearAllMocks();

        result = await sut.executeCommand(barCommand);
        expect(fooApplication.executeCommand).not.toBeCalled();
        expect(barApplication.executeCommand).toBeCalledWith(barCommand);
        expect(result).toBe(resultOfBar);
    });

    test("when no matching application found, returns ApplicationError", async () => {
        const sut = new SimpleCompositeApplication({});

        const result = await sut.executeCommand(new FooCommand());

        expectApplicationError(result);
    });

    test("handling event, dispatched event is handled by all applications", async () => {
        const applications = Array.from({ length: 10 }).map(() =>
            createApplicationMock()
        );
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            applications.reduce(
                (acc, cur, index) => ({
                    ...acc,
                    [`prefix-${index}`]: cur,
                }),
                {} as Record<string, Application>
            ),
            unitOfWork
        );

        await sut.handleEvent(event);

        for (const app of applications) {
            expect(app.handleEvent).toBeCalledWith(event);
        }
    });

    test("returning error occurred during event handling", async () => {
        const errorResult = new ErrorResult(
            new ApplicationError({
                message: "error message",
            })
        );
        const application = createApplicationMock({
            eventResult: errorResult,
        });
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            {
                "does-not-execute-commands": application,
            },
            unitOfWork
        );

        const result = await sut.handleEvent(event);

        expect(result).toBe(errorResult);
    });

    test("event handlers are run concurrently", async () => {
        const handlingTime = 100;
        const timeTakingHandle = async () => {
            await waitForMs(handlingTime);
            return new SuccessResult(null);
        };

        const application1 = createApplicationMock({
            handleEvent: timeTakingHandle,
        });
        const application2 = createApplicationMock({
            handleEvent: timeTakingHandle,
        });
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            {
                "1": application1,
                "2": application2,
            },
            unitOfWork
        );

        await expectExecutionTimeLessThan(
            () => sut.handleEvent(event),
            handlingTime + 10 // 10 is the jitter
        );
    });

    test("event handling is fail-fast", async () => {
        let isApplication2Completed = false;
        const application1 = createApplicationMock({
            handleEvent: async () => {
                await waitForTicks(1);
                return new ErrorResult(
                    new ApplicationError({
                        message: "error message",
                    })
                );
            },
        });
        const application2 = createApplicationMock({
            handleEvent: async () => {
                // wait for one more tick to ensure that this handler takes longer than application1
                await waitForTicks(2);

                isApplication2Completed = true;
                return new SuccessResult(null);
            },
        });
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            {
                "1": application1,
                "2": application2,
            },
            unitOfWork
        );

        await sut.handleEvent(event);

        expect(isApplication2Completed).toBe(false);
    });

    test("throws error when handleEvent is called without UnitOfWork", async () => {
        const application = createApplicationMock();
        const sut = new SimpleCompositeApplication({
            foo: application,
        });

        await expect(sut.handleEvent(event)).rejects.toThrow(
            "Unit of work not set for CompositeApplication"
        );
    });

    test("event handling runs inside UnitOfWork.wrap()", async () => {
        const application = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            {
                foo: application,
            },
            unitOfWork
        );

        await sut.handleEvent(event);

        expect(unitOfWork.wrapSpy).toHaveBeenCalledTimes(1);
    });

    test("can set UnitOfWork using setUnitOfWork() method", async () => {
        const application = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication({
            foo: application,
        });
        sut.setUnitOfWork(unitOfWork);

        await sut.handleEvent(event);

        expect(unitOfWork.wrapSpy).toHaveBeenCalledTimes(1);
        expect(application.handleEvent).toBeCalledWith(event);
    });

    test.todo("returning report about event handling when successful");
});

describe("InterceptedApplication with CompositeApplication", () => {
    const FooCommand = createDummyCommandClass("foo.command");
    const FooEvent = createDummyEventClass("foo.event");

    function createApplicationMock({
        commandResult,
        eventResult,
    }: Partial<{
        commandResult: Result<any>;
        eventResult: Result<any>;
    }> = {}) {
        return {
            executeCommand: vi
                .fn()
                .mockResolvedValue(
                    commandResult ?? new SuccessResult("result")
                ),
            executeQuery: vi
                .fn()
                .mockResolvedValue(new SuccessResult("query result")),
            handleEvent: vi
                .fn()
                .mockResolvedValue(eventResult ?? new SuccessResult(null)),
        };
    }

    test("executes command interceptors before delegating to CompositeApplication", async () => {
        const interceptorSpy = vi.fn();
        const commandInterceptor: CommandInterceptor = async (ctx, next) => {
            interceptorSpy(ctx.message);
            return next();
        };
        const innerApp = createApplicationMock();
        const compositeApp = new SimpleCompositeApplication({ foo: innerApp });
        const command = new FooCommand();

        const sut = new InterceptedApplication(
            compositeApp,
            [commandInterceptor],
            [],
            [],
            []
        );

        await sut.executeCommand(command);

        expect(interceptorSpy).toHaveBeenCalledWith(command);
        expect(innerApp.executeCommand).toHaveBeenCalledWith(command);
    });

    test("executes event interceptors before delegating to CompositeApplication", async () => {
        const interceptorSpy = vi.fn();
        const eventInterceptor: EventInterceptor = async (ctx, next) => {
            interceptorSpy(ctx.message);
            return next();
        };
        const innerApp = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();
        const compositeApp = new SimpleCompositeApplication(
            { foo: innerApp },
            unitOfWork
        );
        const event = new FooEvent();

        const sut = new InterceptedApplication(
            compositeApp,
            [],
            [],
            [eventInterceptor],
            []
        );

        await sut.handleEvent(event);

        expect(interceptorSpy).toHaveBeenCalledWith(event);
        expect(innerApp.handleEvent).toHaveBeenCalledWith(event);
    });

    test("command interceptors are executed in registration order", async () => {
        const executionOrder: number[] = [];
        const innerApp = createApplicationMock();
        const compositeApp = new SimpleCompositeApplication({ foo: innerApp });

        const sut = new InterceptedApplication(
            compositeApp,
            [
                createCommandExecutionTrackingInterceptor(executionOrder, 1),
                createCommandExecutionTrackingInterceptor(executionOrder, 2),
                createCommandExecutionTrackingInterceptor(executionOrder, 3),
            ],
            [],
            [],
            []
        );

        await sut.executeCommand(new FooCommand());

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    test("event interceptors are executed in registration order", async () => {
        const executionOrder: number[] = [];
        const innerApp = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();
        const compositeApp = new SimpleCompositeApplication(
            { foo: innerApp },
            unitOfWork
        );

        const sut = new InterceptedApplication(
            compositeApp,
            [],
            [],
            [
                createEventExecutionTrackingInterceptor(executionOrder, 1),
                createEventExecutionTrackingInterceptor(executionOrder, 2),
                createEventExecutionTrackingInterceptor(executionOrder, 3),
            ],
            []
        );

        await sut.handleEvent(new FooEvent());

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    test("command interceptor can short-circuit by not calling next()", async () => {
        const earlyReturnResult = new SuccessResult("intercepted");
        const commandInterceptor: CommandInterceptor = async () =>
            earlyReturnResult;
        const innerApp = createApplicationMock();
        const compositeApp = new SimpleCompositeApplication({ foo: innerApp });

        const sut = new InterceptedApplication(
            compositeApp,
            [commandInterceptor],
            [],
            [],
            []
        );

        const result = await sut.executeCommand(new FooCommand());

        expect(result).toBe(earlyReturnResult);
        expect(innerApp.executeCommand).not.toHaveBeenCalled();
    });

    test("event interceptor can short-circuit by not calling next()", async () => {
        const earlyReturnResult = new SuccessResult(null);
        const eventInterceptor: EventInterceptor = async () =>
            earlyReturnResult;
        const innerApp = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();
        const compositeApp = new SimpleCompositeApplication(
            { foo: innerApp },
            unitOfWork
        );

        const sut = new InterceptedApplication(
            compositeApp,
            [],
            [],
            [eventInterceptor],
            []
        );

        const result = await sut.handleEvent(new FooEvent());

        expect(result).toBe(earlyReturnResult);
        expect(innerApp.handleEvent).not.toHaveBeenCalled();
    });

    test("throws error when next() is called more than once in command interceptor", async () => {
        const commandInterceptor: CommandInterceptor = async (_, next) => {
            await next();
            return next(); // second call should throw
        };
        const innerApp = createApplicationMock();
        const compositeApp = new SimpleCompositeApplication({ foo: innerApp });

        const sut = new InterceptedApplication(
            compositeApp,
            [commandInterceptor],
            [],
            [],
            []
        );

        await expect(sut.executeCommand(new FooCommand())).rejects.toThrow(
            "next() can only be called once in an interceptor"
        );
    });

    test("throws error when next() is called more than once in event interceptor", async () => {
        const eventInterceptor: EventInterceptor = async (_, next) => {
            await next();
            return next(); // second call should throw
        };
        const innerApp = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();
        const compositeApp = new SimpleCompositeApplication(
            { foo: innerApp },
            unitOfWork
        );

        const sut = new InterceptedApplication(
            compositeApp,
            [],
            [],
            [eventInterceptor],
            []
        );

        await expect(sut.handleEvent(new FooEvent())).rejects.toThrow(
            "next() can only be called once in an interceptor"
        );
    });

    test("interceptors can share data via context metadata", async () => {
        const USER_ID = Symbol("userId");
        const capturedUserId: string[] = [];

        const enrichmentInterceptor: CommandInterceptor = async (ctx, next) => {
            ctx.metadata[USER_ID] = "user-123";
            return next();
        };

        const capturingInterceptor: CommandInterceptor = async (ctx, next) => {
            capturedUserId.push(ctx.metadata[USER_ID] as string);
            return next();
        };

        const innerApp = createApplicationMock();
        const compositeApp = new SimpleCompositeApplication({ foo: innerApp });

        const sut = new InterceptedApplication(
            compositeApp,
            [enrichmentInterceptor, capturingInterceptor],
            [],
            [],
            []
        );

        await sut.executeCommand(new FooCommand());

        expect(capturedUserId).toEqual(["user-123"]);
    });
});
