import { describe, expect, it, vi } from "vitest";

import { ErrorResult, SuccessResult } from "@/application";
import { ApplicationError } from "@/error";
import { CommandInterceptionContext, CommandInterceptor } from "@/interceptor";
import {
    createApplicationBuilder,
    createMockCommandHandler,
    DummyCommand,
} from "@/test";

describe("Real-world Interceptor Scenarios", () => {
    const command = new DummyCommand();

    describe("Logging Scenario", () => {
        interface LogEntry {
            level: string;
            message: string;
            duration?: number;
        }

        function createLoggingInterceptor(): {
            interceptor: CommandInterceptor;
            logs: LogEntry[];
        } {
            const logs: LogEntry[] = [];

            const interceptor: CommandInterceptor = async (ctx, next) => {
                const commandType = ctx.message.getMessageType();
                logs.push({
                    level: "info",
                    message: `[START] ${commandType}`,
                });

                const start = Date.now();
                const result = await next();
                const duration = Date.now() - start;

                if (result.isSuccess) {
                    logs.push({
                        level: "info",
                        message: `[SUCCESS] ${commandType}`,
                        duration,
                    });
                } else {
                    logs.push({
                        level: "error",
                        message: `[ERROR] ${commandType}`,
                        duration,
                    });
                }

                return result;
            };

            return { interceptor, logs };
        }

        it("logs command execution start and end with duration", async () => {
            const { interceptor, logs } = createLoggingInterceptor();

            await createApplicationBuilder()
                .withCommandHandler(DummyCommand, () =>
                    createMockCommandHandler({ result: "success" })
                )
                .withCommandInterceptor(interceptor)
                .build()
                .executeCommand(command);

            expect(logs.length).toBe(2);
            expect(logs[0]).toMatchObject({
                level: "info",
                message: "[START] DummyCommand",
            });
            expect(logs[1]).toMatchObject({
                level: "info",
                message: "[SUCCESS] DummyCommand",
                duration: expect.any(Number),
            });
        });
    });

    describe("Caching Scenario", () => {
        function createCachingInterceptor(): CommandInterceptor {
            const cache = new Map<string, any>();

            return async (ctx, next) => {
                const cacheKey = ctx.message.getMessageId();

                if (cache.has(cacheKey)) {
                    return new SuccessResult(cache.get(cacheKey));
                }

                const result = await next();
                if (result.isSuccess) {
                    cache.set(cacheKey, result.data);
                }
                return result;
            };
        }

        it("returns cached result without executing handler on cache hit", async () => {
            const interceptor = createCachingInterceptor();

            const handler = createMockCommandHandler({ result: "computed" });
            const app = createApplicationBuilder()
                .withCommandHandler(DummyCommand, () => handler)
                .withCommandInterceptor(interceptor)
                .build();

            const firstResult = await app.executeCommand(command);
            const secondResult = await app.executeCommand(command);

            expect(handler.execute).toHaveBeenCalledTimes(1);
            expect(firstResult.isSuccess).toBe(true);
            expect(secondResult.isSuccess).toBe(true);
            if (firstResult.isSuccess && secondResult.isSuccess) {
                expect(firstResult.data).toEqual({ result: "computed" });
                expect(secondResult.data).toEqual({ result: "computed" });
            }
        });
    });

    describe("Authorization Scenario", () => {
        function createAuthInterceptor(
            userPermissions: string[]
        ): CommandInterceptor {
            return async (ctx, next) => {
                const requiredPermission = "admin";

                if (!userPermissions.includes(requiredPermission)) {
                    return new ErrorResult(
                        new ApplicationError({
                            message: "Permission denied",
                        })
                    );
                }

                return next();
            };
        }

        it("blocks command execution when authorization fails", async () => {
            const handler = createMockCommandHandler();
            const emptyPermissions: string[] = [];
            const app = createApplicationBuilder()
                .withCommandHandler(DummyCommand, () => handler)
                .withCommandInterceptor(createAuthInterceptor(emptyPermissions))
                .build();

            const command = new DummyCommand();
            const result = await app.executeCommand(command);

            expect(result.isError).toBe(true);
            expect(handler.execute).not.toHaveBeenCalled();

            if (result.isError) {
                expect(result.error.message).toBe("Permission denied");
            }
        });
    });

    describe("Context Enrichment + Audit Scenario", () => {
        function createContextEnrichmentInterceptor(): CommandInterceptor {
            return async (ctx, next) => {
                ctx.metadata["userId"] = "user-123";
                ctx.metadata["tenantId"] = "tenant-456";
                ctx.metadata["timestamp"] = Date.now();
                return next();
            };
        }

        interface AuditLog {
            userId: string;
            action: string;
            timestamp: number;
        }

        function createAuditInterceptor(): {
            interceptor: CommandInterceptor;
            auditLogs: AuditLog[];
        } {
            const auditLogs: AuditLog[] = [];

            const interceptor: CommandInterceptor = async (ctx, next) => {
                const result = await next();

                if (result.isSuccess) {
                    auditLogs.push({
                        userId: ctx.metadata["userId"] as string,
                        action: ctx.message.getMessageType(),
                        timestamp: ctx.metadata["timestamp"] as number,
                    });
                }

                return result;
            };

            return { interceptor, auditLogs };
        }

        it("enriches context with user info and uses it for audit logging", async () => {
            const { interceptor: auditInterceptor, auditLogs } =
                createAuditInterceptor();

            const handler = createMockCommandHandler();
            const app = createApplicationBuilder()
                .withCommandHandler(DummyCommand, () => handler)
                .withCommandInterceptor(createContextEnrichmentInterceptor())
                .withCommandInterceptor(auditInterceptor)
                .build();

            const command = new DummyCommand();
            await app.executeCommand(command);

            expect(auditLogs.length).toBe(1);
            expect(auditLogs[0]).toMatchObject({
                userId: "user-123",
                action: "DummyCommand",
                timestamp: expect.any(Number),
            });
        });
    });

    describe("Performance Monitoring Scenario", () => {
        interface SlowCommandReport {
            type: string;
            duration: number;
        }

        function createPerformanceInterceptor(slowThresholdMs: number = 100): {
            interceptor: CommandInterceptor;
            slowCommandReports: SlowCommandReport[];
        } {
            const slowCommandReports: SlowCommandReport[] = [];

            const interceptor: CommandInterceptor = async (ctx, next) => {
                const start = Date.now();
                const result = await next();
                const duration = Date.now() - start;

                if (duration > slowThresholdMs) {
                    slowCommandReports.push({
                        type: ctx.message.getMessageType(),
                        duration,
                    });
                }

                return result;
            };

            return { interceptor, slowCommandReports };
        }

        it("reports slow commands that exceed threshold", async () => {
            const { interceptor, slowCommandReports } =
                createPerformanceInterceptor();

            const slowHandlerDelayMs = 150;
            const slowHandler = {
                execute: vi.fn().mockImplementation(async () => {
                    await new Promise((resolve) =>
                        setTimeout(resolve, slowHandlerDelayMs)
                    );
                    return { result: "slow operation" };
                }),
            };

            const thresholdMs = 100;
            const app = createApplicationBuilder()
                .withCommandHandler(DummyCommand, () => slowHandler)
                .withCommandInterceptor(interceptor)
                .build();

            const command = new DummyCommand();
            await app.executeCommand(command);

            expect(slowCommandReports.length).toBe(1);
            expect(slowCommandReports[0].type).toBe("DummyCommand");
            expect(slowCommandReports[0].duration).toBeGreaterThan(thresholdMs);
        });
    });
});
