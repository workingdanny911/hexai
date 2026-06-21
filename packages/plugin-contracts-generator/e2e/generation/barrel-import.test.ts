import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    E2ETestContext,
    expectFileExists,
    expectFileContains,
    expectTypeScriptCompiles,
    expectCommand,
} from "@e2e/helpers";

describe("E2E: Barrel Import (Directory Import Resolution)", () => {
    /**
     * Tests for barrel import resolution bug fix:
     *
     * Previously, `import { X } from "./domain"` would fail because the resolver
     * looked for `./domain.ts` instead of `./domain/index.ts`.
     *
     * This test verifies that directory imports (without explicit /index.ts)
     * are correctly resolved to the barrel file (index.ts).
     */

    const ctx = new E2ETestContext("barrel-import");

    beforeAll(async () => {
        await ctx.setup();
        await ctx.runParser({
            messageTypes: ["command"],
            dependencyStrategy: "file",
        });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Command Extraction", () => {
        it("should extract CreateUserCommand", async () => {
            const result = await ctx.runParser({
                messageTypes: ["command"],
                dependencyStrategy: "file",
            });
            expectCommand(result, "CreateUserCommand");
        });
    });

    describe("Dependency File Resolution", () => {
        it("should copy domain/index.ts (barrel file)", () => {
            expectFileExists(
                ctx.getOutputFile("barrel-import", "domain", "index.ts")
            );
        });

        it("should copy domain/types.ts (re-exported types)", () => {
            expectFileExists(
                ctx.getOutputFile("barrel-import", "domain", "types.ts")
            );
        });

        it("should copy domain/value-objects.ts (re-exported class)", () => {
            expectFileExists(
                ctx.getOutputFile("barrel-import", "domain", "value-objects.ts")
            );
        });
    });

    describe("Import Path Normalization", () => {
        it("should normalize directory import path to explicit NodeNext-safe index.js", async () => {
            await expectFileContains(
                ctx.getOutputFile("barrel-import", "commands.ts"),
                ['from "./domain/index.js"']
            );
        });

        it("should not preserve the extensionless directory import path", async () => {
            const content = await import("fs/promises").then((fs) =>
                fs.readFile(
                    ctx.getOutputFile("barrel-import", "commands.ts"),
                    "utf-8"
                )
            );
            expect(content).not.toContain('from "./domain"');
        });
    });

    describe("TypeScript Compilation", () => {
        it("should compile without errors (ultimate validation)", async () => {
            await expectTypeScriptCompiles(ctx.getOutputDir());
        });
    });
});
