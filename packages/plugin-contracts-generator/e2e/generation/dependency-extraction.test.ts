import { describe, it, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileExists,
    expectFileNotContains,
    expectTypeScriptCompiles,
} from "@e2e/helpers";

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
                dependencyStrategy: "file",
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should import types used in extends clause of local interfaces", async () => {
            // When a local interface extends an imported type,
            // that imported type must be included in the generated imports
            await expectFileContains(
                ctx.getOutputFile(
                    "dependency-extraction/query-with-extends.ts"
                ),
                ["import", "BaseProfile", 'from "./base-types.js"']
            );
        });

        it("should include the local interface that extends the imported type", async () => {
            await expectFileContains(
                ctx.getOutputFile(
                    "dependency-extraction/query-with-extends.ts"
                ),
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
                dependencyStrategy: "file",
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should import functions called in static method body", async () => {
            // When a method body calls imported functions,
            // those functions must be included in the generated imports
            await expectFileContains(
                ctx.getOutputFile(
                    "dependency-extraction/query-with-extends.ts"
                ),
                ["import", "generateId", 'from "./base-types.js"']
            );
        });

        it("should import all functions called in method body", async () => {
            await expectFileContains(
                ctx.getOutputFile(
                    "dependency-extraction/query-with-extends.ts"
                ),
                ["import", "formatDate", 'from "./base-types.js"']
            );
        });
    });

    describe("TypeScript Compilation", () => {
        const ctx = new E2ETestContext("dependency-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["query"],
                dependencyStrategy: "file",
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

    describe("Import shape dependency resolution", () => {
        const ctx = new E2ETestContext("dependency-extraction");

        beforeAll(async () => {
            await ctx.setup();
            await ctx.runParser({
                messageTypes: ["query"],
                dependencyStrategy: "file",
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        const outputFile = () =>
            ctx.getOutputFile("dependency-extraction/import-shapes-query.ts");

        it("should preserve default and type-only default imports", async () => {
            await expectFileContains(outputFile(), [
                'import DefaultProfile from "./default-profile.js";',
                'import type TypeOnlyDefault from "./type-only-default.js";',
                "primary: DefaultProfile",
                "typeOnly: TypeOnlyDefault",
            ]);
        });

        it("should preserve namespace imports and nested qualified type names", async () => {
            await expectFileContains(outputFile(), [
                'import * as Types from "./namespace-types.js";',
                "namespaceUser: Types.User",
                "nestedNamespaceUser: Types.Inner.User",
            ]);
        });

        it("should preserve named import aliases", async () => {
            await expectFileContains(outputFile(), [
                'import { AliasedUser as DomainUser } from "./aliased-user.js";',
                "owner: DomainUser",
            ]);
        });

        it("should preserve mixed imports and remove unused named imports", async () => {
            await expectFileContains(outputFile(), [
                'import MixedDefault, { MixedUserSource as MixedUser } from "./mixed-user.js";',
                "mixedDefault: MixedDefault",
                "mixedUser: MixedUser",
            ]);

            await expectFileNotContains(outputFile(), ["UnusedUser"]);
        });

        it("should preserve already exported local function dependencies", async () => {
            await expectFileContains(outputFile(), [
                "export function deriveImportShapeLabel",
                "deriveImportShapeLabel(this.payload.primary.id)",
            ]);

            await expectFileNotContains(outputFile(), [
                "export export function deriveImportShapeLabel",
            ]);
        });

        it("should copy dependency files referenced by retained import shapes", () => {
            for (const fileName of [
                "default-profile.ts",
                "namespace-types.ts",
                "aliased-user.ts",
                "mixed-user.ts",
                "type-only-default.ts",
            ]) {
                expectFileExists(
                    ctx.getOutputFile("dependency-extraction", fileName)
                );
            }
        });

        it("should compile generated output", async () => {
            await expectTypeScriptCompiles(ctx.getOutputDir());
        });
    });
});
