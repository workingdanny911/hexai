import type { Result } from "../application";
import type {
    CommandInterceptionContext,
    CommandInterceptor,
    EventInterceptionContext,
    EventInterceptor,
    InterceptionContext,
    Interceptor,
} from "../interceptor";
import {
    asTrace,
    correlationOf,
    type MessageTrace,
} from "../messaging-support";

export const CURRENT_MESSAGE_TRACE_KEY = Symbol("currentMessageTrace");
export const CORRELATION_TRACE_KEY = Symbol("correlationTrace");

export function getCurrentMessageTrace(
    metadata: Record<string | symbol, unknown>
): MessageTrace | undefined {
    return metadata[CURRENT_MESSAGE_TRACE_KEY] as MessageTrace | undefined;
}

export function getCorrelationTrace(
    metadata: Record<string | symbol, unknown>
): MessageTrace | undefined {
    return metadata[CORRELATION_TRACE_KEY] as MessageTrace | undefined;
}

function propagateTrace(ctx: InterceptionContext): void {
    const message = ctx.message;
    const currentTrace = asTrace(message);
    ctx.metadata[CURRENT_MESSAGE_TRACE_KEY] = currentTrace;

    const correlationTrace = correlationOf(message) ?? currentTrace;
    ctx.metadata[CORRELATION_TRACE_KEY] = correlationTrace;
}

export function createTraceInterceptor(): Interceptor {
    return async (
        ctx: InterceptionContext,
        next: () => Promise<Result<unknown>>
    ): Promise<Result<unknown>> => {
        propagateTrace(ctx);
        return next();
    };
}

export const traceCommandInterceptor: CommandInterceptor = async (
    ctx: CommandInterceptionContext,
    next: () => Promise<Result<unknown>>
): Promise<Result<unknown>> => {
    propagateTrace(ctx);
    return next();
};

export const traceEventInterceptor: EventInterceptor = async (
    ctx: EventInterceptionContext,
    next: () => Promise<Result<unknown>>
): Promise<Result<unknown>> => {
    propagateTrace(ctx);
    return next();
};

// Backward compatibility - deprecated, use traceCommandInterceptor instead
export class TraceCommandInterceptor {
    asInterceptor(): CommandInterceptor {
        return traceCommandInterceptor;
    }
}

// Backward compatibility - deprecated, use traceEventInterceptor instead
export class TraceEventInterceptor {
    asInterceptor(): EventInterceptor {
        return traceEventInterceptor;
    }
}
