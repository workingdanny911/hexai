import { Message } from "@hexaijs/core";

import type { Result } from "@/application";
import type { Logger, LogContext } from "./logger";

export interface LoggingInterceptorConfig {
    logger: Logger;
    slowThresholdMs?: number;
    excludeTypes?: string[];
    includeTracing?: boolean;
}

const COMMON_METADATA_FIELDS = [
    "requestId",
    "traceId",
    "spanId",
    "userId",
    "tenantId",
] as const;

export function serializeError(error: unknown): LogContext["error"] {
    if (error instanceof Error) {
        return {
            name: error.constructor.name,
            message: error.message,
            code: (error as { code?: string }).code,
            stack: error.stack,
        };
    }
    return {
        name: "UnknownError",
        message: String(error),
    };
}

export function extractMetadataFields(
    metadata: Record<string, unknown>,
    logContext: LogContext
): void {
    for (const field of COMMON_METADATA_FIELDS) {
        if (typeof metadata[field] === "string") {
            logContext[field] = metadata[field] as string;
        }
    }
}

export function buildLogContext(
    message: Message,
    metadata: Record<string, unknown>,
    includeTracing: boolean
): LogContext {
    const trace = message.asTrace();

    const logContext: LogContext = {
        messageId: trace.id,
        messageType: trace.type,
    };

    if (includeTracing) {
        const correlation = message.getCorrelation();
        if (correlation) {
            logContext.correlationId = correlation.id;
            logContext.correlationType = correlation.type;
        }

        const causation = message.getCausation();
        if (causation) {
            logContext.causationId = causation.id;
            logContext.causationType = causation.type;
        }
    }

    extractMetadataFields(metadata, logContext);

    return logContext;
}

export type MessageKind = "command" | "event";

const LOG_MESSAGES: Record<
    MessageKind,
    {
        started: string;
        completed: string;
        failed: string;
        exception: string;
        slow: string;
    }
> = {
    command: {
        started: "Command execution started",
        completed: "Command execution completed",
        failed: "Command execution failed",
        exception: "Command execution failed with exception",
        slow: "Slow command execution detected",
    },
    event: {
        started: "Event handling started",
        completed: "Event handling completed",
        failed: "Event handling failed",
        exception: "Event handling failed with exception",
        slow: "Slow event handling detected",
    },
};

export function getLogMessage(
    kind: MessageKind,
    phase: "started" | "completed" | "failed" | "exception" | "slow"
): string {
    return LOG_MESSAGES[kind][phase];
}

export function logCompletion(
    logger: Logger,
    result: Result<unknown>,
    durationMs: number,
    slowThresholdMs: number | undefined,
    kind: MessageKind
): void {
    if (slowThresholdMs && durationMs > slowThresholdMs) {
        logger.warn({ durationMs }, getLogMessage(kind, "slow"));
    }

    if (result.isSuccess) {
        logger.info({ durationMs }, getLogMessage(kind, "completed"));
    } else {
        logger.error(
            {
                durationMs,
                error: serializeError(result.error),
            },
            getLogMessage(kind, "failed")
        );
    }
}
