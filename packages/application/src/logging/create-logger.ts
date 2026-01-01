import pino from "pino";

import type { Logger, LoggerConfig } from "./logger";

export function createLogger(config: LoggerConfig): Logger {
    const pinoOptions: pino.LoggerOptions = {
        level: config.level,
        base: config.base ?? {},
        redact: config.redactPaths,
    };

    if (config.pretty) {
        pinoOptions.transport = {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:standard",
                ignore: "pid,hostname",
            },
        };
    }

    return pino(pinoOptions) as unknown as Logger;
}

export interface TestLogEntry {
    level: number;
    time: number;
    msg: string;
    [key: string]: unknown;
}

export interface TestLogger extends Logger {
    getLogs(): TestLogEntry[];
    clear(): void;
    findLog(predicate: (log: TestLogEntry) => boolean): TestLogEntry | undefined;
    findLogs(predicate: (log: TestLogEntry) => boolean): TestLogEntry[];
}

export function createTestLogger(config?: Partial<LoggerConfig>): TestLogger {
    const logs: TestLogEntry[] = [];

    const stream = {
        write(msg: string) {
            logs.push(JSON.parse(msg));
        },
    };

    const pinoLogger = pino(
        {
            level: config?.level ?? "debug",
            base: config?.base ?? {},
        },
        stream
    ) as pino.Logger;

    const testLogger = Object.assign(pinoLogger, {
        getLogs: () => logs,
        clear: () => {
            logs.length = 0;
        },
        findLog: (predicate: (log: TestLogEntry) => boolean) =>
            logs.find(predicate),
        findLogs: (predicate: (log: TestLogEntry) => boolean) =>
            logs.filter(predicate),
    }) as TestLogger;

    return testLogger;
}
