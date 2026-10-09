import vm from "node:vm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { UnitOfWork } from "@hexaijs/core";
import { waitForMs, waitForTicks } from "@hexaijs/core/test";

import { Application, ErrorResult, Result, SuccessResult } from "./application.js";
import { InterceptedApplication } from "./intercepted-application.js";
import { ApplicationError } from "./error.js";
import { CommandInterceptor, EventInterceptor } from "./interceptor.js";
import {
    createCommandExecutionTrackingInterceptor,
    createDeferred,
    createEventExecutionTrackingInterceptor,
    DummyCommand,
    DummyEvent,
    expectApplicationError,
    expectErrorResult,
    expectExecutionTimeLessThan,
    trackSettlement,
} from "./test/index.js";
import { SimpleCompositeApplication } from "./simple-composite-application.js";

function createMockUnitOfWork(): UnitOfWork<void, never> & {
    scopeSpy: ReturnType<typeof vi.fn>;
} {
    const scopeSpy = vi.fn();
    return {
        scope: async <T>(fn: () => Promise<T>): Promise<T> => {
            scopeSpy();
            return fn();
        },
        scopeSpy,
    };
}

function createRecordingUnitOfWork(): UnitOfWork<void, never> & {
    log: string[];
    rejections: unknown[];
    write(entry: string): void;
} {
    const log: string[] = [];
    const rejections: unknown[] = [];
    return {
        scope: async <T>(fn: () => Promise<T>): Promise<T> => {
            log.push("begin");
            try {
                const result = await fn();
                log.push("commit");
                return result;
            } catch (e) {
                log.push("rollback");
                rejections.push(e);
                throw e;
            }
        },
        log,
        rejections,
        write(entry: string) {
            log.push(entry);
        },
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

    test("commits and returns a success result when every application succeeds", async () => {
        const unitOfWork = createRecordingUnitOfWork();
        const sut = new SimpleCompositeApplication(
            {
                "1": createApplicationMock(),
                "2": createApplicationMock(),
            },
            unitOfWork
        );

        const result = await sut.handleEvent(event);

        expect(result).toEqual(new SuccessResult(null));
        expect(unitOfWork.log).toEqual(["begin", "commit"]);
    });

    test("rolls back only after every application has settled when one fails", async () => {
        const errorResult = new ErrorResult(
            new ApplicationError({
                message: "error message",
            })
        );
        const slowApplicationGate = createDeferred();
        const unitOfWork = createRecordingUnitOfWork();
        const failingApplication = createApplicationMock({
            eventResult: errorResult,
        });
        const slowApplication = createApplicationMock({
            handleEvent: async () => {
                await slowApplicationGate.promise;
                unitOfWork.write("slow application write");
                return new SuccessResult(null);
            },
        });

        const sut = new SimpleCompositeApplication(
            {
                "1": failingApplication,
                "2": slowApplication,
            },
            unitOfWork
        );

        const handling = trackSettlement(sut.handleEvent(event));
        await waitForTicks();

        expect(handling.isSettled).toBe(false);

        slowApplicationGate.resolve();

        expect(await handling.promise).toBe(errorResult);
        expect(unitOfWork.log).toEqual([
            "begin",
            "slow application write",
            "rollback",
        ]);
    });

    test("does not commit a later application's write when an earlier application throws", async () => {
        const failure = new Error("application crashed");
        const unitOfWork = createRecordingUnitOfWork();
        const throwingApplication = createApplicationMock({
            handleEvent: () => {
                throw failure;
            },
        });
        const writingApplication = createApplicationMock({
            handleEvent: async () => {
                await waitForTicks(1);
                unitOfWork.write("later application write");
                return new SuccessResult(null);
            },
        });

        const sut = new SimpleCompositeApplication(
            {
                "1": throwingApplication,
                "2": writingApplication,
            },
            unitOfWork
        );

        const result = await sut.handleEvent(event);

        expectApplicationError(result, {
            message: "application crashed",
            cause: failure,
        });
        expect(unitOfWork.log).toEqual([
            "begin",
            "later application write",
            "rollback",
        ]);
    });

    describe("when an application fails with a falsy value", () => {
        test.each([undefined, null, 0, ""])(
            "rejects the scope with an Error and returns an error result for %j",
            async (falsyFailure) => {
                const unitOfWork = createRecordingUnitOfWork();
                const sut = new SimpleCompositeApplication(
                    {
                        foo: createApplicationMock({
                            handleEvent: () => Promise.reject(falsyFailure),
                        }),
                    },
                    unitOfWork
                );

                const result = await sut.handleEvent(event);

                expectErrorResult(result);
                expect(unitOfWork.log).toEqual(["begin", "rollback"]);
                expect(unitOfWork.rejections).toEqual([expect.any(Error)]);
            }
        );

        test("rejects the scope with an Error for an error result without an error", async () => {
            const errorResultWithoutError = new ErrorResult(
                undefined as unknown as Error
            );
            const unitOfWork = createRecordingUnitOfWork();
            const sut = new SimpleCompositeApplication(
                {
                    foo: createApplicationMock({
                        eventResult: errorResultWithoutError,
                    }),
                },
                unitOfWork
            );

            const result = await sut.handleEvent(event);

            expect(result).toBe(errorResultWithoutError);
            expect(unitOfWork.rejections).toEqual([expect.any(Error)]);
        });
    });

    describe("when the unit of work itself fails", () => {
        test("rejects when the scope cannot begin", async () => {
            const beginFailure = new Error("cannot begin");
            const application = createApplicationMock();
            const unitOfWork: UnitOfWork<void, never> = {
                scope: async () => {
                    throw beginFailure;
                },
            };
            const sut = new SimpleCompositeApplication(
                { foo: application },
                unitOfWork
            );

            await expect(sut.handleEvent(event)).rejects.toBe(beginFailure);
            expect(application.handleEvent).not.toBeCalled();
        });

        test("rejects when committing fails", async () => {
            const commitFailure = new Error("commit failed");
            const unitOfWork: UnitOfWork<void, never> = {
                scope: async <T>(fn: () => Promise<T>): Promise<T> => {
                    await fn();
                    throw commitFailure;
                },
            };
            const sut = new SimpleCompositeApplication(
                { foo: createApplicationMock() },
                unitOfWork
            );

            await expect(sut.handleEvent(event)).rejects.toBe(commitFailure);
        });

        test("rejects when rolling back an application failure fails", async () => {
            const rollbackFailure = new Error("rollback failed");
            const unitOfWork: UnitOfWork<void, never> = {
                scope: async <T>(fn: () => Promise<T>): Promise<T> => {
                    try {
                        return await fn();
                    } catch {
                        throw rollbackFailure;
                    }
                },
            };
            const sut = new SimpleCompositeApplication(
                {
                    foo: createApplicationMock({
                        eventResult: new ErrorResult(
                            new ApplicationError({ message: "app failure" })
                        ),
                    }),
                },
                unitOfWork
            );

            await expect(sut.handleEvent(event)).rejects.toBe(
                rollbackFailure
            );
        });

        test("still returns the application's failure when the unit of work does not rethrow it", async () => {
            const errorResult = new ErrorResult(
                new ApplicationError({ message: "app failure" })
            );
            const swallowingUnitOfWork: UnitOfWork<void, never> = {
                scope: async <T>(fn: () => Promise<T>): Promise<T> => {
                    try {
                        return await fn();
                    } catch {
                        return undefined as T;
                    }
                },
            };
            const sut = new SimpleCompositeApplication(
                {
                    foo: createApplicationMock({ eventResult: errorResult }),
                },
                swallowingUnitOfWork
            );

            expect(await sut.handleEvent(event)).toBe(errorResult);
        });
    });

    describe("normalizing an application failure into an error result", () => {
        async function handleEventFailingWith(failure: unknown) {
            const sut = new SimpleCompositeApplication(
                {
                    foo: createApplicationMock({
                        handleEvent: () => Promise.reject(failure),
                    }),
                },
                createMockUnitOfWork()
            );
            const result = await sut.handleEvent(event);
            expectErrorResult(result);
            return result;
        }

        test("keeps a structured failure value reachable through the cause chain", async () => {
            const structuredFailure = {
                code: "40001",
                message: "serialization failure",
            };

            const result = await handleEventFailingWith(structuredFailure);

            expectApplicationError(result, {
                message: "serialization failure",
            });
            expect((result.error.cause as Error).cause).toBe(
                structuredFailure
            );
        });

        test("keeps an error from another realm in the cause chain", async () => {
            const foreignError = vm.runInNewContext("new Error('x')");

            const result = await handleEventFailingWith(foreignError);

            expectApplicationError(result, { message: "x" });
            expect((result.error.cause as Error).cause).toBe(foreignError);
        });

        test("turns a null-prototype failure value into an error result", async () => {
            const nullPrototypeFailure = Object.create(null);

            const result = await handleEventFailingWith(nullPrototypeFailure);

            expectApplicationError(result, { message: "[object Object]" });
            expect((result.error.cause as Error).cause).toBe(
                nullPrototypeFailure
            );
        });

        test("preserves an error result created by another copy of this package", async () => {
            const foreignErrorResult = {
                isSuccess: false,
                isError: true,
                error: new ApplicationError({ message: "foreign failure" }),
                getOrThrow(): never {
                    throw this.error;
                },
            };
            const sut = new SimpleCompositeApplication(
                {
                    foo: createApplicationMock({
                        eventResult: foreignErrorResult as Result<any>,
                    }),
                },
                createMockUnitOfWork()
            );

            expect(await sut.handleEvent(event)).toBe(foreignErrorResult);
        });

        test("does not mistake an error carrying only an isError flag for an error result", async () => {
            const flaggedError = Object.assign(new Error("failure"), {
                isError: true,
            });

            const result = await handleEventFailingWith(flaggedError);

            expectApplicationError(result, {
                message: "failure",
                cause: flaggedError,
            });
        });
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

    test("event handling runs inside UnitOfWork.scope()", async () => {
        const application = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication(
            {
                foo: application,
            },
            unitOfWork
        );

        await sut.handleEvent(event);

        expect(unitOfWork.scopeSpy).toHaveBeenCalledTimes(1);
    });

    test("can set UnitOfWork using setUnitOfWork() method", async () => {
        const application = createApplicationMock();
        const unitOfWork = createMockUnitOfWork();

        const sut = new SimpleCompositeApplication({
            foo: application,
        });
        sut.setUnitOfWork(unitOfWork);

        await sut.handleEvent(event);

        expect(unitOfWork.scopeSpy).toHaveBeenCalledTimes(1);
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
