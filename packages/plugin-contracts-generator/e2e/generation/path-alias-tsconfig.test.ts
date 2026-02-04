import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { readFile } from "fs/promises";
import { join } from "path";
import type { ProcessContextResult } from "@/index";
import {
    E2ETestContext,
    expectGeneratedFiles,
    expectFileContains,
} from "@e2e/helpers";

describe("E2E: tsconfig.json Path Alias Resolution", () => {
    const ctx = new E2ETestContext("path-alias");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();

        result = await ctx.runParser({
            tsconfigPath: join(ctx.getFixtureDir(), "tsconfig.json"),
        });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Path Alias Resolution via tsconfig", () => {
        it("should resolve @/decorators and include decorators/index.ts in dependencies", () => {
            const decoratorsFile = result.copiedFiles.find((f) =>
                f.includes("decorators")
            );
            expect(decoratorsFile).toBeDefined();
        });

        it("should copy all resolved files including decorators", () => {
            expect(result.copiedFiles.length).toBeGreaterThanOrEqual(4);
        });

        it("should generate decorators directory in output", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "path-alias", [
                "index.ts",
                "commands.ts",
                "events.ts",
                "types.ts",
                "decorators/index.ts",
            ]);
        });
    });

    describe("Import Transformation", () => {
        it("should transform @/decorators to relative path in commands.ts", async () => {
            const commandsContent = await readFile(
                ctx.getOutputFile("path-alias", "commands.ts"),
                "utf-8"
            );

            expect(commandsContent).not.toContain('from "@/decorators"');
            expect(commandsContent).toContain('from "./decorators/index"');
        });

        it("should transform @/decorators to relative path in events.ts", async () => {
            const eventsContent = await readFile(
                ctx.getOutputFile("path-alias", "events.ts"),
                "utf-8"
            );

            expect(eventsContent).not.toContain('from "@/decorators"');
            expect(eventsContent).toContain('from "./decorators/index"');
        });
    });

    describe("Copied Decorators Content", () => {
        it("should contain PublicEvent and PublicCommand in copied decorators file", async () => {
            await expectFileContains(
                ctx.getOutputFile("path-alias", "decorators/index.ts"),
                ["PublicEvent", "PublicCommand"]
            );
        });
    });
});
