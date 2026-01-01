import { beforeEach, describe, expect, test, vi } from "vitest";

import { SuccessResult } from "@/application";
import { CommandInterceptor, CommandInterceptionContext } from "@/interceptor";
import {
    DummyCommand,
    createApplicationBuilder,
    createMockCommandHandler,
    createCommandExecutionTrackingInterceptor,
} from "@/test";

describe("Application, command interceptor", () => {
    const command = new DummyCommand();
    const commandHandlerMock = createMockCommandHandler();

    beforeEach(() => {
        vi.resetAllMocks();
    });

    function createAppWithInterceptor(...interceptors: CommandInterceptor[]) {
        const builder = createApplicationBuilder().withCommandHandler(
            DummyCommand,
            () => commandHandlerMock
        );

        interceptors.forEach((interceptor) =>
            builder.withCommandInterceptor(interceptor)
        );

        return builder.build();
    }

    test("executes registered command interceptor when command is dispatched", async () => {
        const mockInterceptor: CommandInterceptor = vi.fn(
            async (ctx: CommandInterceptionContext, next) => {
                return await next();
            }
        );

        await createAppWithInterceptor(mockInterceptor).executeCommand(command);

        expect(mockInterceptor).toHaveBeenCalledTimes(1);
    });

    test("executes multiple interceptors in registration order", async () => {
        const executionOrder: number[] = [];
        const interceptor1 = createCommandExecutionTrackingInterceptor(
            executionOrder,
            1
        );
        const interceptor2 = createCommandExecutionTrackingInterceptor(
            executionOrder,
            2
        );
        const interceptor3 = createCommandExecutionTrackingInterceptor(
            executionOrder,
            3
        );

        await createAppWithInterceptor(
            interceptor1,
            interceptor2,
            interceptor3
        ).executeCommand(command);

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    test("allows interceptor to return early without calling next", async () => {
        const cachedResult = new SuccessResult({
            cached: true,
            value: "cached-data",
        });
        const earlyReturnInterceptor: CommandInterceptor = async (ctx, next) =>
            cachedResult;

        const result = await createAppWithInterceptor(
            earlyReturnInterceptor
        ).executeCommand(command);

        expect(commandHandlerMock.execute).toHaveBeenCalledTimes(0);
        expect(result.isSuccess).toBe(true);
        expect(result).toBe(cachedResult);
    });

    test("throws error when next() is called more than once", async () => {
        const doubleCallInterceptor: CommandInterceptor = async (ctx, next) => {
            await next();
            await next();
            return new SuccessResult(null);
        };

        const application = createAppWithInterceptor(doubleCallInterceptor);

        await expect(application.executeCommand(command)).rejects.toThrow();
    });

    test("allows interceptors to share data via context metadata", async () => {
        const userIdEnrichmentInterceptor: CommandInterceptor = async (
            ctx,
            next
        ) => {
            ctx.metadata["userId"] = "user123";
            return await next();
        };
        let capturedUserId: string | undefined;
        const userIdCapturingInterceptor: CommandInterceptor = async (
            ctx,
            next
        ) => {
            capturedUserId = ctx.metadata["userId"] as string;
            return await next();
        };

        await createAppWithInterceptor(
            userIdEnrichmentInterceptor,
            userIdCapturingInterceptor
        ).executeCommand(command);

        expect(capturedUserId).toBe("user123");
    });
});
