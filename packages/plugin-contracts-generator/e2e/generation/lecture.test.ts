import { describe, it, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectGeneratedFiles,
    expectExtractionResult,
    expectEvents,
    expectCommands,
} from "@e2e/helpers";
import type { ProcessContextResult } from "@/index";

describe("E2E: Message Parser", () => {
    const ctx = new E2ETestContext("lecture");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Extraction", () => {
        it("should extract correct number of events and commands", () => {
            expectExtractionResult(result, {
                eventCount: 2,
                commandCount: 1,
            });
        });

        it("should extract expected events", () => {
            expectEvents(result, ["LectureCreated", "LectureDeleted"]);
        });

        it("should extract expected commands", () => {
            expectCommands(result, ["CreateLecture"]);
        });
    });

    describe("File Generation", () => {
        it("should copy all source files with dependencies", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "lecture", [
                "index.ts",
                "events.ts",
                "commands.ts",
                "types.ts",
            ]);
        });

        describe("events.ts", () => {
            it("should contain event classes", async () => {
                await expectFileContains(
                    ctx.getOutputFile("lecture/events.ts"),
                    [
                        "export class LectureCreated",
                        "export class LectureDeleted",
                    ]
                );
            });

            it("should include event fields", async () => {
                await expectFileContains(
                    ctx.getOutputFile("lecture/events.ts"),
                    ["lectureId"]
                );
            });
        });

        describe("commands.ts", () => {
            it("should contain command classes", async () => {
                await expectFileContains(
                    ctx.getOutputFile("lecture/commands.ts"),
                    ["export class CreateLecture"]
                );
            });

            it("should include command fields", async () => {
                await expectFileContains(
                    ctx.getOutputFile("lecture/commands.ts"),
                    ["title", "instructorId"]
                );
            });
        });

        describe("index.ts", () => {
            it("should re-export entry point files", async () => {
                await expectFileContains(
                    ctx.getOutputFile("lecture/index.ts"),
                    ["export * from './events'", "export * from './commands'"]
                );
            });
        });
    });
});
