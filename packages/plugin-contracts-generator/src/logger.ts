export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export interface ConsoleLoggerOptions {
    level?: LogLevel;
}

export class ConsoleLogger implements Logger {
    private readonly level: LogLevel;

    constructor(options: ConsoleLoggerOptions = {}) {
        this.level = options.level ?? "info";
    }

    debug(message: string): void {
        if (this.shouldLog("debug")) {
            console.debug(message);
        }
    }

    info(message: string): void {
        if (this.shouldLog("info")) {
            console.info(message);
        }
    }

    warn(message: string): void {
        if (this.shouldLog("warn")) {
            console.warn(message);
        }
    }

    error(message: string): void {
        if (this.shouldLog("error")) {
            console.error(message);
        }
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
    }
}

class NoopLogger implements Logger {
    debug(): void {}
    info(): void {}
    warn(): void {}
    error(): void {}
}

export const noopLogger: Logger = new NoopLogger();
