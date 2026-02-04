import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import {
    E2ETestContext,
    expectFileContains,
    expectGeneratedFiles,
} from "@e2e/helpers";
import type { ProcessContextResult } from "@/index";

/**
 * E2E: Module Structure
 *
 * Tests the file-graph-copy approach with:
 * - Non-standard file naming (not commands.ts/events.ts)
 * - Deep dependency tracking via BFS
 * - Shared dependencies (diamond pattern)
 *
 * Dependency graph:
 *   commands-but-different-filename.ts
 *            ├─────────┴─────────┐
 *            ↓                   ↓
 *     foo.validator.ts    bar.validator.ts
 *            └─────────┬─────────┘
 *                      ↓
 *               is-empty.ts
 */
describe("E2E: Module Structure", () => {
    const ctx = new E2ETestContext("module-structure");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Command Extraction", () => {
        it("should extract command from non-standard filename", () => {
            expect(result.commands).toHaveLength(1);
            expect(result.commands[0].name).toBe("SomeCommand");
        });

        it("should have no events", () => {
            expect(result.events).toHaveLength(0);
        });
    });

    describe("File Copying with Deep Dependencies", () => {
        it("should copy all files in dependency graph", () => {
            expect(result.copiedFiles.length).toBe(4);
        });

        it("should preserve original file names", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "module-structure", [
                "index.ts",
                "commands-but-different-filename.ts",
                "foo.validator.ts",
                "bar.validator.ts",
                "is-empty.ts",
            ]);
        });
    });

    describe("Entry Point File (commands-but-different-filename.ts)", () => {
        it("should preserve command class with decorator", async () => {
            await expectFileContains(
                ctx.getOutputFile(
                    "module-structure",
                    "commands-but-different-filename.ts"
                ),
                ["@PublicCommand()", "export class SomeCommand"]
            );
        });

        it("should preserve imports from dependencies", async () => {
            await expectFileContains(
                ctx.getOutputFile(
                    "module-structure",
                    "commands-but-different-filename.ts"
                ),
                ['from "./foo.validator"', 'from "./bar.validator"']
            );
        });

        it("should preserve method implementation", async () => {
            await expectFileContains(
                ctx.getOutputFile(
                    "module-structure",
                    "commands-but-different-filename.ts"
                ),
                [
                    "validate()",
                    "FooValidator.validateFoo(foo)",
                    "validateBar(bar)",
                ]
            );
        });
    });

    describe("Validator Dependencies", () => {
        it("should copy foo.validator.ts with class export", async () => {
            await expectFileContains(
                ctx.getOutputFile("module-structure", "foo.validator.ts"),
                [
                    "export class FooValidator",
                    "validateFoo(value: string)",
                    'from "./is-empty"',
                ]
            );
        });

        it("should copy bar.validator.ts with function export", async () => {
            await expectFileContains(
                ctx.getOutputFile("module-structure", "bar.validator.ts"),
                ["export function validateBar", 'from "./is-empty"']
            );
        });
    });

    describe("Shared Dependency (Diamond Pattern)", () => {
        it("should copy is-empty.ts (shared by both validators)", async () => {
            await expectFileContains(
                ctx.getOutputFile("module-structure", "is-empty.ts"),
                ["export function isEmpty"]
            );
        });

        it("should copy shared dependency only once", async () => {
            const isEmptyFiles = result.copiedFiles.filter((f) =>
                f.includes("is-empty")
            );
            expect(isEmptyFiles.length).toBe(1);
        });
    });

    describe("Barrel Export", () => {
        it("should export entry point and all dependencies in index.ts", async () => {
            const indexContent = await readFile(
                ctx.getOutputFile("module-structure", "index.ts"),
                "utf-8"
            );

            // Entry point should be exported
            expect(indexContent).toContain("./commands-but-different-filename");
            // All dependencies should also be exported for type accessibility
            expect(indexContent).toContain("foo.validator");
            expect(indexContent).toContain("bar.validator");
            expect(indexContent).toContain("is-empty");
        });

        it("should export entry points before dependencies", async () => {
            const indexContent = await readFile(
                ctx.getOutputFile("module-structure", "index.ts"),
                "utf-8"
            );
            const lines = indexContent.split("\n");

            // Entry point should come first
            expect(lines[0]).toContain("commands-but-different-filename");
        });
    });
});
