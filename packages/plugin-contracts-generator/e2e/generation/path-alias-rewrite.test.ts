import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import type { ProcessContextResult } from "../../src/index";
import {
    E2ETestContext,
    expectGeneratedFiles,
    expectFileContains,
} from "../helpers";

/*
 * Example transformation tested:
 *   @/decorators  ->  @libera/decorators
 */
describe("E2E: Path Alias Transformation", () => {
    const ctx = new E2ETestContext("path-alias");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();

        // Custom path alias rewrites for this test (override default @/decorators handling)
        const pathAliasRewrites = new Map<string, string>([
            ["@/decorators", "@libera/decorators"],
        ]);

        result = await ctx.runParser({ pathAliasRewrites });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Extraction", () => {
        it("should extract events", () => {
            expect(result.events).toHaveLength(2);
            const eventNames = result.events.map((e) => e.name);
            expect(eventNames).toContain("UserCreated");
            expect(eventNames).toContain("UserDeleted");
        });

        it("should extract commands", () => {
            expect(result.commands).toHaveLength(2);
            const commandNames = result.commands.map((c) => c.name);
            expect(commandNames).toContain("CreateUser");
            expect(commandNames).toContain("DeleteUser");
        });
    });

    describe("File Copying", () => {
        it("should copy all source files with dependencies", () => {
            expect(result.copiedFiles.length).toBe(3);
        });

        it("should generate all required files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "path-alias", [
                "index.ts",
                "commands.ts",
                "events.ts",
                "types.ts",
            ]);
        });
    });

    describe("Path Alias Transformation in commands.ts", () => {
        it("should transform @/decorators to @libera/decorators", async () => {
            const commandsContent = await readFile(
                ctx.getOutputFile("path-alias", "commands.ts"),
                "utf-8"
            );

            expect(commandsContent).not.toContain('from "@/decorators"');
            expect(commandsContent).toContain('from "@libera/decorators"');
        });

        it("should preserve other imports unchanged", async () => {
            await expectFileContains(
                ctx.getOutputFile("path-alias", "commands.ts"),
                ['from "@hexaijs/core"', 'from "./types"']
            );
        });
    });

    describe("Path Alias Transformation in events.ts", () => {
        it("should transform @/decorators to @libera/decorators", async () => {
            const eventsContent = await readFile(
                ctx.getOutputFile("path-alias", "events.ts"),
                "utf-8"
            );

            expect(eventsContent).not.toContain('from "@/decorators"');
            expect(eventsContent).toContain('from "@libera/decorators"');
        });

        it("should preserve other imports unchanged", async () => {
            await expectFileContains(
                ctx.getOutputFile("path-alias", "events.ts"),
                ['from "@hexaijs/core"', 'from "./types"']
            );
        });
    });

    describe("Non-Entry Point Files", () => {
        it("should copy types.ts unchanged", async () => {
            await expectFileContains(
                ctx.getOutputFile("path-alias", "types.ts"),
                [
                    "export type UserId",
                    "export type Email",
                    "export type UserProfile",
                ]
            );
        });
    });

    describe("Barrel Export", () => {
        it("should export entry point files", async () => {
            await expectFileContains(
                ctx.getOutputFile("path-alias", "index.ts"),
                ["export * from './commands'", "export * from './events'"]
            );
        });
    });
});
