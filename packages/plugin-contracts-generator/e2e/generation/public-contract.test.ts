import { readFile } from "node:fs/promises";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileNotContains,
    expectFileNotExists,
    expectGeneratedFiles,
} from "@e2e/helpers";
import type { ProcessContextResult } from "../../src/index.js";

describe("E2E: PublicContract comment markers", () => {
    describe("default generation", () => {
        const ctx = new E2ETestContext("public-contract");
        let result: ProcessContextResult;
        let registryPath: string;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser();
            registryPath = await ctx.generateRegistry(result);
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should extract PublicContract-only declarations without messages", () => {
            expect(result.events).toHaveLength(0);
            expect(result.commands).toHaveLength(0);
            expect(result.queries).toHaveLength(0);
            expect(result.publicContracts).toHaveLength(4);

            const declarationKindsByName = new Map(
                result.publicContracts.map((contract) => [
                    contract.name,
                    contract.declarationKind,
                ])
            );
            expect(declarationKindsByName).toEqual(
                new Map([
                    ["PublicProfile", "interface"],
                    ["PublicUserId", "type"],
                    ["PublicProjection", "class"],
                    ["PublicStatus", "enum"],
                ])
            );
            expect(result.publicContracts.every((contract) => !contract.exported)).toBe(
                true
            );
        });

        it("should generate the PublicContract-only source file and barrel export", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "public-contract", [
                "index.ts",
                "contracts.ts",
            ]);
        });

        it("should export PublicContract-only declarations in generated output", async () => {
            await expectFileContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "export interface PublicProfile",
                    "export type PublicUserId",
                    "export class PublicProjection",
                    "export enum PublicStatus",
                ]
            );
        });

        it("should exclude unmarked declarations from PublicContract-only files", async () => {
            await expectFileNotContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "InternalProfileRecord",
                    "secretToken",
                    "InternalProjection",
                ]
            );
        });

        it("should barrel export the generated contract file", async () => {
            await expectFileContains(
                ctx.getOutputFile("public-contract/index.ts"),
                "export * from './contracts'"
            );
        });

        it("should not register PublicContract-only declarations in MessageRegistry", async () => {
            const registryContent = await readFile(registryPath, "utf-8");

            expect(registryContent).toContain(
                "export const messageRegistry = new MessageRegistry();"
            );
            expect(registryContent).not.toContain(".register(");
            await expectFileNotContains(registryPath, [
                "PublicProfile",
                "PublicUserId",
                "PublicProjection",
                "PublicStatus",
            ]);
        });
    });

    describe("messageTypes filtering", () => {
        const ctx = new E2ETestContext("public-contract");
        let result: ProcessContextResult;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser({
                messageTypes: ["event"],
            });
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should not include PublicContract-only files when filtering to events", () => {
            expect(result.events).toHaveLength(0);
            expect(result.commands).toHaveLength(0);
            expect(result.queries).toHaveLength(0);
            expect(result.publicContracts).toHaveLength(0);
            expect(result.copiedFiles).toHaveLength(0);
            expectFileNotExists(
                ctx.getOutputFile("public-contract/contracts.ts")
            );
        });
    });
});
