import { describe, it, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileNotContains,
    expectTypeScriptCompilesWithNodeNext,
} from "@e2e/helpers";

describe("E2E: Safe Symbol Dependency Slicing", () => {
    const ctx = new E2ETestContext("safe-symbol-dependency-slicing");

    beforeAll(async () => {
        await ctx.setup();
        await ctx.runParser({
            messageTypes: ["query"],
            entryStrategy: "symbols",
            dependencyStrategy: "safe-symbols",
            removeDecorators: true,
        });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    it("should slice direct and transitive dependency files", async () => {
        await expectFileContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/profile-query.ts"
            ),
            [
                "export class GetProfileQuery extends QueryBase",
                'from "./profile-dependencies.js"',
                'from "./type-only-shape.js"',
            ]
        );
        await expectFileNotContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/profile-query.ts"
            ),
            ["UnusedProfile", "@ContractQuery"]
        );

        await expectFileContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/profile-dependencies.ts"
            ),
            [
                "export abstract class QueryBase",
                "interface ProfileMetadata",
                "const localPrefix",
                "export interface UsedProfile",
                "export function buildProfileLabel",
                'from "./transitive-formatters.js"',
            ]
        );
        await expectFileNotContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/profile-dependencies.ts"
            ),
            ["UnusedProfile", "unusedProfileLabel", "unusedFormat"]
        );

        await expectFileContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/transitive-formatters.ts"
            ),
            "export function formatProfileId"
        );
        await expectFileNotContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/transitive-formatters.ts"
            ),
            "unusedFormat"
        );

        await expectFileContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/type-only-shape.ts"
            ),
            "export interface TypeOnlyShape"
        );
        await expectFileNotContains(
            ctx.getOutputFile(
                "safe-symbol-dependency-slicing/type-only-shape.ts"
            ),
            "UnusedTypeOnlyShape"
        );
    });

    it("should compile generated output with NodeNext module resolution", async () => {
        await expectTypeScriptCompilesWithNodeNext(ctx.getOutputDir());
    });
});
