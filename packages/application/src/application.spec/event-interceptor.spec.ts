import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventInterceptor, EventInterceptionContext } from "@/interceptor";
import {
    DummyEvent,
    createApplicationBuilder,
    createMockEventHandler,
    createEventExecutionTrackingInterceptor,
} from "@/test";

describe("Application, event interceptor", () => {
    const eventHandlerMock = createMockEventHandler();
    const event = new DummyEvent();

    beforeEach(() => {
        vi.resetAllMocks();
    });

    function createAppWithInterceptor(...interceptors: EventInterceptor[]) {
        const builder = createApplicationBuilder().withEventHandler(
            () => eventHandlerMock
        );

        interceptors.forEach((interceptor) =>
            builder.withEventInterceptor(interceptor)
        );

        return builder.build();
    }

    test("executes registered event interceptor when event is handled", async () => {
        const mockInterceptor: EventInterceptor = vi.fn(
            async (ctx: EventInterceptionContext, next) => {
                return await next();
            }
        );

        await createAppWithInterceptor(mockInterceptor).handleEvent(event);

        expect(mockInterceptor).toHaveBeenCalledTimes(1);
    });

    test("passes event in context to interceptor", async () => {
        let capturedEvent: any = null;
        const eventCapturingInterceptor: EventInterceptor = async (
            ctx,
            next
        ) => {
            capturedEvent = ctx.message;
            return await next();
        };

        await createAppWithInterceptor(eventCapturingInterceptor).handleEvent(
            event
        );

        expect(capturedEvent).toBe(event);
    });

    test("executes multiple event interceptors in registration order", async () => {
        const executionOrder: number[] = [];
        const interceptor1 = createEventExecutionTrackingInterceptor(
            executionOrder,
            1
        );
        const interceptor2 = createEventExecutionTrackingInterceptor(
            executionOrder,
            2
        );
        const interceptor3 = createEventExecutionTrackingInterceptor(
            executionOrder,
            3
        );

        await createAppWithInterceptor(
            interceptor1,
            interceptor2,
            interceptor3
        ).handleEvent(event);

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    test("allows event interceptors to share data via context metadata", async () => {
        const traceIdEnrichmentInterceptor: EventInterceptor = async (
            ctx,
            next
        ) => {
            ctx.metadata["traceId"] = "trace-abc-123";
            return await next();
        };
        let capturedTraceId: string | undefined;
        const traceIdCapturingInterceptor: EventInterceptor = async (
            ctx,
            next
        ) => {
            capturedTraceId = ctx.metadata["traceId"] as string;
            return await next();
        };

        await createAppWithInterceptor(
            traceIdEnrichmentInterceptor,
            traceIdCapturingInterceptor
        ).handleEvent(event);

        expect(capturedTraceId).toBe("trace-abc-123");
    });
});
