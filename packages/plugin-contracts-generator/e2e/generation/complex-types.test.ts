import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectGeneratedFiles,
    expectTypeScriptCompiles,
} from "../helpers";
import type { ProcessContextResult } from "@/index";

describe("E2E: Complex Types", () => {
    const ctx = new E2ETestContext("complex-types");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser();
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Extraction", () => {
        it("should extract all events with complex payloads", () => {
            expect(result.events).toHaveLength(6);
            const eventNames = result.events.map((e) => e.name);
            expect(eventNames).toContain("UserCreated");
            expect(eventNames).toContain("UserStatusChanged");
            expect(eventNames).toContain("UserRolesUpdated");
            expect(eventNames).toContain("UserAddressUpdated");
            expect(eventNames).toContain("NestedDataProcessed");
            expect(eventNames).toContain("BatchUsersProcessed");
        });

        it("should extract all commands", () => {
            expect(result.commands).toHaveLength(5);
            const commandNames = result.commands.map((c) => c.name);
            expect(commandNames).toContain("CreateUser");
            expect(commandNames).toContain("UpdateUserRoles");
            expect(commandNames).toContain("UpdateUserAddress");
            expect(commandNames).toContain("SearchUsers");
            expect(commandNames).toContain("BatchUpdateStatus");
        });

        it("should copy all source files with dependencies", () => {
            expect(result.copiedFiles.length).toBe(3);
        });
    });

    describe("File Generation", () => {
        it("should copy all source files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "complex-types", [
                "events.ts",
                "commands.ts",
                "types.ts",
                "index.ts",
            ]);
        });
    });

    describe("types.ts", () => {
        it("should contain union type literals", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "types.ts"),
                [
                    'export type Status = "pending" | "active" | "suspended" | "deleted";',
                    'export type Role = "admin" | "user" | "guest";',
                ]
            );
        });

        it("should contain nested object types", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "types.ts"),
                [
                    "export type Address =",
                    "street: string",
                    "city: string",
                    "zipCode?: string",
                ]
            );
        });

        it("should contain types with array fields", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "types.ts"),
                [
                    "actions: string[]",
                    "roles: Role[]",
                    "permissions: Permission[]",
                ]
            );
        });
    });

    describe("events.ts", () => {
        it("should contain import from @hexaijs/core", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "events.ts"),
                ['import { Message } from "@hexaijs/core"']
            );
        });

        it("should contain event classes", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "events.ts"),
                ["export class UserCreated", "profile: UserProfile"]
            );
        });

        it("should contain nested inline objects", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "events.ts"),
                [
                    "export class BatchUsersProcessed",
                    "summary:",
                    "total: number",
                    "succeeded: number",
                ]
            );
        });
    });

    describe("commands.ts", () => {
        it("should contain import from @hexaijs/core", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "commands.ts"),
                ['import { Message } from "@hexaijs/core"']
            );
        });

        it("should contain optional fields", async () => {
            await expectFileContains(
                ctx.getOutputFile("complex-types", "commands.ts"),
                ["contact?: ContactInfo", "initialRoles?: Role[]"]
            );
        });
    });

    describe("TypeScript Compilation", () => {
        it("should compile without errors", async () => {
            await expectTypeScriptCompiles(ctx.getGeneratedDir());
        });
    });
});
