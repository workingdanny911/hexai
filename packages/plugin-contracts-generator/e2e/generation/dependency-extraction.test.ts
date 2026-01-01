import { describe, it, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectTypeScriptCompiles,
} from "../helpers";

describe("E2E: Dependency Extraction", () => {
    /**
     * Tests for proper dependency extraction:
     * 1. ExpressionWithTypeArguments: Local interfaces extending imported types
     * 2. CallExpression: Method bodies calling imported functions
     */

    describe("ExpressionWithTypeArguments (extends clause)", () => {
        const ctx = new E2ETestContext("dependency-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["query"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should import types used in extends clause of local interfaces", async () => {
            // When a local interface extends an imported type,
            // that imported type must be included in the generated imports
            await expectFileContains(
                ctx.getOutputFile("dependency-extraction/query-with-extends.ts"),
                ["import", "BaseProfile", 'from "./base-types"']
            );
        });

        it("should include the local interface that extends the imported type", async () => {
            await expectFileContains(
                ctx.getOutputFile("dependency-extraction/query-with-extends.ts"),
                ["export interface ExtendedProfile extends BaseProfile"]
            );
        });
    });

    describe("CallExpression (function calls in method body)", () => {
        const ctx = new E2ETestContext("dependency-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["query"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should import functions called in static method body", async () => {
            // When a method body calls imported functions,
            // those functions must be included in the generated imports
            await expectFileContains(
                ctx.getOutputFile("dependency-extraction/query-with-extends.ts"),
                ["import", "generateId", 'from "./base-types"']
            );
        });

        it("should import all functions called in method body", async () => {
            await expectFileContains(
                ctx.getOutputFile("dependency-extraction/query-with-extends.ts"),
                ["import", "formatDate", 'from "./base-types"']
            );
        });
    });

    describe("TypeScript Compilation", () => {
        const ctx = new E2ETestContext("dependency-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["query"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should compile without TypeScript errors", async () => {
            // This verifies that all dependencies are properly imported
            // If any import is missing, TypeScript compilation will fail
            await expectTypeScriptCompiles(ctx.getOutputDir());
        });
    });
});
