import { describe, it, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileNotContains,
    expectFileNotExists,
    expectGeneratedFiles,
    expectExtractionResult,
    expectEvents,
    expectCommands,
} from "@e2e/helpers";
import type { ProcessContextResult } from "@/index";

describe("E2E: Symbol Extraction", () => {
    /**
     * Core principle: "Target message + its dependencies only"
     * Everything else should be excluded (whitelist approach)
     */

    describe("messageTypes filtering (-m event)", () => {
        const ctx = new E2ETestContext("symbol-extraction");
        let result: ProcessContextResult;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser({
                messageTypes: ["event"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        describe("Extraction", () => {
            it("should extract only events, not commands", () => {
                expectExtractionResult(result, {
                    eventCount: 1,
                    commandCount: 0,
                });
            });

            it("should extract the target event", () => {
                expectEvents(result, ["UserRegistered"]);
            });
        });

        describe("File Generation", () => {
            it("should generate entry file", () => {
                expectGeneratedFiles(ctx.getOutputDir(), "symbol-extraction", [
                    "index.ts",
                    "mixed-messages.ts",
                ]);
            });

            describe("mixed-messages.ts", () => {
                it("should contain target event class", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class UserRegistered"]
                    );
                });

                it("should contain target event dependencies (payload)", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export interface UserRegisteredPayload"]
                    );
                });

                it("should contain DomainEvent import (used by target)", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["import { DomainEvent }"]
                    );
                });

                it("should NOT contain command class (different messageType)", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class RegisterUser"]
                    );
                });

                it("should NOT contain command dependencies", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        [
                            "export interface RegisterUserPayload",
                            "export interface RegisterUserResponse",
                        ]
                    );
                });

                it("should NOT contain handler class", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class RegisterUserHandler"]
                    );
                });

                it("should NOT contain handler-only imports", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        [
                            "CommandHandlerMarker",
                            "BaseUseCase",
                            "ExecutionScope",
                            "UserRepository",
                        ]
                    );
                });

                it("should NOT contain unrelated symbols", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        [
                            "export interface SomeUnrelatedType",
                            "export function someUnrelatedFunction",
                        ]
                    );
                });
            });
        });
    });

    describe("messageTypes filtering (-m command)", () => {
        const ctx = new E2ETestContext("symbol-extraction");
        let result: ProcessContextResult;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser({
                messageTypes: ["command"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        describe("Extraction", () => {
            it("should extract only commands, not events", () => {
                expectExtractionResult(result, {
                    eventCount: 0,
                    commandCount: 1,
                });
            });

            it("should extract the target command", () => {
                expectCommands(result, ["RegisterUser"]);
            });
        });

        describe("File Generation", () => {
            describe("mixed-messages.ts", () => {
                it("should contain target command class", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class RegisterUser"]
                    );
                });

                it("should contain target command dependencies", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        [
                            "export interface RegisterUserPayload",
                            "export interface RegisterUserResponse",
                        ]
                    );
                });

                it("should contain Message import (used by target)", async () => {
                    await expectFileContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["import", "Message"]
                    );
                });

                it("should NOT contain event class (different messageType)", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class UserRegistered"]
                    );
                });

                it("should NOT contain event dependencies", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export interface UserRegisteredPayload"]
                    );
                });

                it("should NOT contain handler class", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        ["export class RegisterUserHandler"]
                    );
                });

                it("should NOT contain handler-only imports", async () => {
                    await expectFileNotContains(
                        ctx.getOutputFile(
                            "symbol-extraction/mixed-messages.ts"
                        ),
                        [
                            "CommandHandlerMarker",
                            "BaseUseCase",
                            "ExecutionScope",
                            "UserRepository",
                        ]
                    );
                });
            });
        });
    });

    describe("Handler-only dependency files", () => {
        const ctx = new E2ETestContext("symbol-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["event"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should NOT copy repository.ts (handler-only dependency)", async () => {
            const repositoryPath = ctx.getOutputFile(
                "symbol-extraction/repository.ts"
            );
            expectFileNotExists(repositoryPath);
        });
    });
});
