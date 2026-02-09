import { describe, expect, it, vi } from "vitest";

import { ApplicationBuilder, ErrorResult } from "@/application";
import { ApplicationError } from "@/error";
import { AbstractApplicationContext } from "@/abstract-application-context";
import { Command } from "@/command";
import {
    CommandInterceptor,
    EventInterceptor,
    Interceptor,
} from "@/interceptor";
import { Message } from "@hexaijs/core";

import {
    createTestLogger,
    createLoggingInterceptor,
    traceCommandInterceptor,
    traceEventInterceptor,
    CURRENT_MESSAGE_TRACE_KEY,
    CORRELATION_TRACE_KEY,
} from "./index";

// Helper to set correlation (handles immutable message)
function withCorrelation<T extends Message<unknown>>(
    message: T,
    correlation: { id: string; type: string }
): T {
    return message
        .withHeader("correlationId", correlation.id)
        .withHeader("correlationType", correlation.type) as T;
}

function withCausation<T extends Message<unknown>>(
    message: T,
    causation: { id: string; type: string }
): T {
    return message
        .withHeader("causationId", causation.id)
        .withHeader("causationType", causation.type) as T;
}

class TestCommand extends Command<{ value: string }> {
    constructor(value: string = "test") {
        super({ value });
    }
}

class TestEvent extends Message<{ data: string }> {
    constructor(
        data: string = "event-data",
        headers: Record<string, unknown> = {}
    ) {
        super({ data }, { headers });
    }
}

class TestApplicationContext extends AbstractApplicationContext {}

function createApplicationBuilder() {
    return new ApplicationBuilder().withApplicationContext(
        new TestApplicationContext()
    );
}

function createMockCommandHandler(result: unknown = { success: true }) {
    return {
        execute: vi.fn().mockResolvedValue(result),
    };
}

function createMockEventHandler() {
    return {
        canHandle: vi.fn().mockReturnValue(true),
        handle: vi.fn().mockResolvedValue(undefined),
    };
}

describe("Logging Module", () => {
    describe("createTestLogger", () => {
        it("captures log entries", () => {
            const testLogger = createTestLogger();

            testLogger.info("test message");

            const logs = testLogger.getLogs();
            expect(logs).toHaveLength(1);
            expect(logs[0].msg).toBe("test message");
        });

        it("captures log entries with context", () => {
            const testLogger = createTestLogger();

            testLogger.info({ userId: "user-123" }, "user action");

            const logs = testLogger.getLogs();
            expect(logs[0]).toMatchObject({
                msg: "user action",
                userId: "user-123",
            });
        });

        it("supports child loggers with inherited context", () => {
            const testLogger = createTestLogger();

            const childLogger = testLogger.child({ requestId: "req-abc" });
            childLogger.info("child log");

            expect(testLogger.getLogs()[0]).toMatchObject({
                msg: "child log",
                requestId: "req-abc",
            });
        });

        it("findLog returns matching entry", () => {
            const testLogger = createTestLogger();

            testLogger.info("first");
            testLogger.error({ code: "E001" }, "error occurred");

            const errorLog = testLogger.findLog(
                (l) => l.msg === "error occurred"
            );
            expect(errorLog).toMatchObject({
                msg: "error occurred",
                code: "E001",
            });
        });

        it("clear removes all logs", () => {
            const testLogger = createTestLogger();

            testLogger.info("message 1");
            testLogger.info("message 2");
            expect(testLogger.getLogs()).toHaveLength(2);

            testLogger.clear();
            expect(testLogger.getLogs()).toHaveLength(0);
        });
    });

    describe("LoggingCommandInterceptor", () => {
        it("logs command execution start and completion", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler({ result: "success" })
                )
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            const logs = testLogger.getLogs();
            expect(logs).toHaveLength(2);
            expect(logs[0].msg).toBe("Command execution started");
            expect(logs[1].msg).toBe("Command execution completed");
            expect(logs[1].durationMs).toBeTypeOf("number");
        });

        it("includes messageId and messageType in logs", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            const startLog = testLogger.getLogs()[0];
            expect(startLog.messageType).toBe("TestCommand");
            expect(startLog.messageId).toBeTypeOf("string");
        });

        it("includes correlation and causation in logs", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            const command = withCausation(
                withCorrelation(new TestCommand(), {
                    id: "corr-123",
                    type: "HttpRequest",
                }),
                { id: "cause-456", type: "UserAction" }
            );

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(command);

            const startLog = testLogger.getLogs()[0];
            expect(startLog).toMatchObject({
                correlationId: "corr-123",
                correlationType: "HttpRequest",
                causationId: "cause-456",
                causationType: "UserAction",
            });
        });

        it("logs error on failed result", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            const appError = new ApplicationError({
                category: "TEST",
                code: "TEST_ERROR",
                message: "Something failed",
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () => ({
                    execute: vi.fn().mockRejectedValue(appError),
                }))
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            const errorLog = testLogger.findLog(
                (l) => l.msg === "Command execution failed"
            );
            expect(errorLog).toBeDefined();
            expect(errorLog?.error).toMatchObject({
                name: "ApplicationError",
                message: "Something failed",
            });
        });

        it("warns on slow execution", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
                slowThresholdMs: 10,
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () => ({
                    execute: vi.fn().mockImplementation(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return { success: true };
                    }),
                }))
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            const slowLog = testLogger.findLog(
                (l) => l.msg === "Slow command execution detected"
            );
            expect(slowLog).toBeDefined();
        });

        it("excludes specified message types", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
                excludeTypes: ["TestCommand"],
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(interceptor as CommandInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            expect(testLogger.getLogs()).toHaveLength(0);
        });

        it("extracts metadata fields into log context", async () => {
            const testLogger = createTestLogger();
            const loggingInterceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            // Create an interceptor that adds metadata
            const metadataInterceptor: CommandInterceptor = async (
                ctx,
                next
            ) => {
                ctx.metadata.userId = "user-abc";
                ctx.metadata.requestId = "req-xyz";
                return next();
            };

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(metadataInterceptor)
                .withCommandInterceptor(
                    loggingInterceptor as CommandInterceptor
                )
                .build();

            await app.executeCommand(new TestCommand());

            expect(testLogger.getLogs()[0]).toMatchObject({
                userId: "user-abc",
                requestId: "req-xyz",
            });
        });
    });

    describe("TraceCommandInterceptor", () => {
        it("stores current message trace in metadata", async () => {
            let capturedMetadata: Record<string | symbol, unknown> | null =
                null;

            const captureInterceptor: CommandInterceptor = async (
                ctx,
                next
            ) => {
                capturedMetadata = ctx.metadata;
                return next();
            };

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(traceCommandInterceptor)
                .withCommandInterceptor(captureInterceptor)
                .build();

            await app.executeCommand(new TestCommand());

            expect(capturedMetadata).not.toBeNull();
            expect(capturedMetadata![CURRENT_MESSAGE_TRACE_KEY]).toBeDefined();
            expect(capturedMetadata![CORRELATION_TRACE_KEY]).toBeDefined();
        });

        it("preserves existing correlation", async () => {
            const testLogger = createTestLogger();
            const loggingInterceptor = createLoggingInterceptor({
                logger: testLogger,
            });

            const command = withCorrelation(new TestCommand(), {
                id: "original-corr",
                type: "OriginalType",
            });

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(traceCommandInterceptor)
                .withCommandInterceptor(
                    loggingInterceptor as CommandInterceptor
                )
                .build();

            await app.executeCommand(command);

            expect(testLogger.getLogs()[0]).toMatchObject({
                correlationId: "original-corr",
                correlationType: "OriginalType",
            });
        });
    });

    describe("LoggingEventInterceptor", () => {
        it("logs event handling start and completion", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });
            const eventHandler = createMockEventHandler();

            const app = createApplicationBuilder()
                .withEventHandler(() => eventHandler)
                .withEventInterceptor(interceptor as EventInterceptor)
                .build();

            await app.handleEvent(new TestEvent());

            const logs = testLogger.getLogs();
            expect(logs).toHaveLength(2);
            expect(logs[0].msg).toBe("Event handling started");
            expect(logs[1].msg).toBe("Event handling completed");
        });

        it("includes correlation and causation in event logs", async () => {
            const testLogger = createTestLogger();
            const interceptor = createLoggingInterceptor({
                logger: testLogger,
            });
            const eventHandler = createMockEventHandler();

            // Pass headers via constructor since TestEvent doesn't support setHeader properly
            const event = new TestEvent("event-data", {
                correlationId: "corr-evt",
                correlationType: "Command",
                causationId: "cause-cmd",
                causationType: "CreateOrder",
            });

            const app = createApplicationBuilder()
                .withEventHandler(() => eventHandler)
                .withEventInterceptor(interceptor as EventInterceptor)
                .build();

            await app.handleEvent(event);

            expect(testLogger.getLogs()[0]).toMatchObject({
                correlationId: "corr-evt",
                causationId: "cause-cmd",
            });
        });
    });

    describe("Integration: Trace + Logging Interceptors", () => {
        it("works together for full observability", async () => {
            const testLogger = createTestLogger();

            const command = withCorrelation(
                new TestCommand("integration-test"),
                {
                    id: "http-req-1",
                    type: "HttpRequest",
                }
            );

            const app = createApplicationBuilder()
                .withCommandHandler(TestCommand, () =>
                    createMockCommandHandler()
                )
                .withCommandInterceptor(traceCommandInterceptor)
                .withCommandInterceptor(
                    createLoggingInterceptor({
                        logger: testLogger,
                        slowThresholdMs: 5000,
                    }) as CommandInterceptor
                )
                .build();

            await app.executeCommand(command);

            const logs = testLogger.getLogs();
            expect(logs).toHaveLength(2);

            // Both logs should have correlation info
            for (const log of logs) {
                expect(log.correlationId).toBe("http-req-1");
                expect(log.messageType).toBe("TestCommand");
            }
        });
    });
});
