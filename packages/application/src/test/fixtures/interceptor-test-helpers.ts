import { vi } from "vitest";
import { ApplicationBuilder, SuccessResult } from "@/application";
import { AbstractApplicationContext } from "@/abstract-application-context";
import { CommandInterceptor, EventInterceptor } from "@/interceptor";

/**
 * Shared test helpers for interceptor tests
 */

export class DummyApplicationContext extends AbstractApplicationContext {}

/**
 * Creates a mock command handler that returns a SuccessResult
 */
export function createMockCommandHandler(data: any = { foo: "bar" }) {
    return {
        execute: vi.fn().mockResolvedValue(data),
    };
}

/**
 * Creates a mock event handler that returns void
 */
export function createMockEventHandler() {
    return {
        canHandle: vi.fn().mockReturnValue(true),
        handle: vi.fn().mockResolvedValue(undefined),
    };
}

/**
 * Creates a basic application builder with DummyApplicationContext pre-configured
 */
export function createApplicationBuilder() {
    return new ApplicationBuilder().withApplicationContext(
        new DummyApplicationContext()
    );
}

/**
 * Creates a command interceptor that tracks execution by appending an ID to an array
 */
export function createCommandExecutionTrackingInterceptor(
    executionOrder: number[],
    id: number
): CommandInterceptor {
    return async (ctx, next) => {
        executionOrder.push(id);
        return await next();
    };
}

/**
 * Creates an event interceptor that tracks execution by appending an ID to an array
 */
export function createEventExecutionTrackingInterceptor(
    executionOrder: number[],
    id: number
): EventInterceptor {
    return async (ctx, next) => {
        executionOrder.push(id);
        return await next();
    };
}
