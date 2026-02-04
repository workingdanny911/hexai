import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFile } from "fs/promises";
import type { ProcessContextResult } from "@/index";
import {
    E2ETestContext,
    expectTypeScriptCompiles,
    expectGeneratedFiles,
    expectFileContains,
} from "@e2e/helpers";

describe("E2E: Class Support", () => {
    const ctx = new E2ETestContext("class-support");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        // Use "lecture" as context name (different from fixture name)
        result = await ctx.runParser({ contextName: "lecture" });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Command Extraction", () => {
        it("should extract commands that use classes", () => {
            expect(result.commands).toHaveLength(1);
            expect(result.commands[0].name).toBe("CreateLecture");
        });
    });

    describe("File Copying", () => {
        it("should copy all source files with dependencies", () => {
            expect(result.copiedFiles.length).toBe(3);
        });

        it("should generate all required files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "lecture", [
                "index.ts",
                "commands.ts",
                "types.ts",
                "domain.ts",
            ]);
        });

        it("should copy domain.ts with class source text", async () => {
            await expectFileContains(
                ctx.getOutputFile("lecture", "domain.ts"),
                [
                    "export class LessonCredit",
                    "export class LessonPrice",
                    "export abstract class Money",
                ]
            );
        });

        it("should preserve class methods in output", async () => {
            await expectFileContains(
                ctx.getOutputFile("lecture", "domain.ts"),
                [
                    "validate(): boolean",
                    "applyDiscount(percent: number)",
                    "add(other: Money): Money",
                ]
            );
        });

        it("should include all base classes in output", async () => {
            await expectFileContains(
                ctx.getOutputFile("lecture", "domain.ts"),
                [
                    "export abstract class ValueObject",
                    "export abstract class Money",
                ]
            );
        });

        it("should preserve import for referenced types", async () => {
            await expectFileContains(
                ctx.getOutputFile("lecture", "domain.ts"),
                ["import type { Currency }"]
            );
        });
    });

    describe("TypeScript Compilation", () => {
        it("should compile generated output without errors", async () => {
            await expectTypeScriptCompiles(ctx.getOutputFile("lecture"));
        });
    });

    describe("Class Source Text Preservation", () => {
        it("should preserve constructor parameters in class source", async () => {
            const classesContent = await readFile(
                ctx.getOutputFile("lecture", "domain.ts"),
                "utf-8"
            );

            expect(classesContent).toContain(
                "constructor(public readonly value: number)"
            );
            expect(classesContent).toContain(
                "constructor(amount: number, currency: Currency)"
            );
        });

        it("should preserve method bodies", async () => {
            const classesContent = await readFile(
                ctx.getOutputFile("lecture", "domain.ts"),
                "utf-8"
            );

            expect(classesContent).toContain(
                "return this.value > 0 && this.value <= 100"
            );
            expect(classesContent).toContain("throw new Error");
        });

        it("should preserve class comments", async () => {
            const classesContent = await readFile(
                ctx.getOutputFile("lecture", "domain.ts"),
                "utf-8"
            );

            expect(classesContent).toContain("Internal base class");
            expect(classesContent).toContain("Extends internal base class");
        });
    });

    describe("Types File", () => {
        it("should copy types.ts with Currency type", async () => {
            await expectFileContains(ctx.getOutputFile("lecture", "types.ts"), [
                "export type Currency",
            ]);
        });
    });

    describe("Commands File", () => {
        it("should copy commands.ts preserving imports", async () => {
            const commandsContent = await readFile(
                ctx.getOutputFile("lecture", "commands.ts"),
                "utf-8"
            );

            expect(commandsContent).toContain('from "./domain"');
            expect(commandsContent).toContain('from "./types"');
            expect(commandsContent).toContain("export class CreateLecture");
        });
    });
});
