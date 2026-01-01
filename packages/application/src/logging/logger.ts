export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogContext {
    messageId?: string;
    messageType?: string;
    correlationId?: string;
    correlationType?: string;
    causationId?: string;
    causationType?: string;
    requestId?: string;
    traceId?: string;
    spanId?: string;
    userId?: string;
    tenantId?: string;
    durationMs?: number;
    error?: {
        name: string;
        message: string;
        code?: string;
        stack?: string;
    };
    [key: string]: unknown;
}

export interface Logger {
    debug(msg: string): void;
    debug(context: LogContext, msg: string): void;

    info(msg: string): void;
    info(context: LogContext, msg: string): void;

    warn(msg: string): void;
    warn(context: LogContext, msg: string): void;

    error(msg: string): void;
    error(context: LogContext, msg: string): void;

    fatal(msg: string): void;
    fatal(context: LogContext, msg: string): void;

    child(bindings: LogContext): Logger;
}

export interface LoggerConfig {
    level: LogLevel;
    pretty?: boolean;
    redactPaths?: string[];
    base?: LogContext;
}