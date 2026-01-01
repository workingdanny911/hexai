import type { Result } from "@/application";
import type { InterceptionContext, Interceptor } from "@/interceptor";
import type { LoggingInterceptorConfig, MessageKind } from "./logging-utils";
import {
    buildLogContext,
    getLogMessage,
    logCompletion,
    serializeError,
} from "./logging-utils";

function getMessageKind(ctx: InterceptionContext): MessageKind {
    return ctx.intent === "query" ? "command" : ctx.intent;
}

export function createLoggingInterceptor(
    config: LoggingInterceptorConfig
): Interceptor {
    return async (
        ctx: InterceptionContext,
        next: () => Promise<Result<unknown>>
    ): Promise<Result<unknown>> => {
        const message = ctx.message;
        const messageType = message.getMessageType();

        if (config.excludeTypes?.includes(messageType)) {
            return next();
        }

        const kind = getMessageKind(ctx);
        const logContext = buildLogContext(
            message,
            ctx.metadata,
            config.includeTracing !== false
        );
        const logger = config.logger.child(logContext);

        logger.info(getLogMessage(kind, "started"));

        const startTime = performance.now();

        try {
            const result = await next();
            const durationMs = Math.round(performance.now() - startTime);

            logCompletion(
                logger,
                result,
                durationMs,
                config.slowThresholdMs,
                kind
            );

            return result;
        } catch (error) {
            const durationMs = Math.round(performance.now() - startTime);
            logger.error(
                {
                    durationMs,
                    error: serializeError(error),
                },
                getLogMessage(kind, "exception")
            );
            throw error;
        }
    };
}

// Backward compatibility - deprecated, use createLoggingInterceptor instead
export class LoggingInterceptor {
    private readonly interceptor: Interceptor;

    constructor(config: LoggingInterceptorConfig) {
        this.interceptor = createLoggingInterceptor(config);
    }

    asInterceptor(): Interceptor {
        return this.interceptor;
    }
}
