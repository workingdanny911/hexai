import { beforeEach, describe, expect, test, vi } from "vitest";

import { Interceptor } from "@/interceptor";
import {
    DummyCommand,
    DummyEvent,
    createApplicationBuilder,
    createMockCommandHandler,
    createMockEventHandler,
} from "@/test";

describe("Application, common interceptor (withInterceptor)", () => {
    const command = new DummyCommand();
    const event = new DummyEvent();

    beforeEach(() => {
        vi.resetAllMocks();
    });

    test("registers interceptor for both commands and events", async () => {
        const commandHandlerMock = createMockCommandHandler();
        const eventHandlerMock = createMockEventHandler();
        const commandInterceptorSpy = vi.fn();
        const eventInterceptorSpy = vi.fn();

        const commonInterceptor: Interceptor = async (ctx, next) => {
            if (ctx.intent === "command" || ctx.intent === "query") {
                commandInterceptorSpy(ctx);
            } else if (ctx.intent === "event") {
                eventInterceptorSpy(ctx);
            }
            return await next();
        };

        const application = createApplicationBuilder()
            .withInterceptor(commonInterceptor)
            .withCommandHandler(DummyCommand, () => commandHandlerMock)
            .withEventHandler(() => eventHandlerMock)
            .build();

        await application.executeCommand(command);
        await application.handleEvent(event);

        expect(commandInterceptorSpy).toHaveBeenCalledTimes(1);
        expect(eventInterceptorSpy).toHaveBeenCalledTimes(1);
        expect(commandHandlerMock.execute).toHaveBeenCalledTimes(1);
        expect(eventHandlerMock.handle).toHaveBeenCalledTimes(1);
    });
});
