import { readFile } from "node:fs/promises";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileNotContains,
    expectGeneratedFiles,
    expectTypeScriptCompiles,
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
            expect(
                result.publicContracts.every((contract) => contract.exported)
            ).toBe(true);
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

        it("should extract only marked declarations by default", async () => {
            await expectFileContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "deriveDisplayName",
                    "DEFAULT_STATUS",
                    "Factory",
                    "Status",
                ]
            );
            await expectFileNotContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "InternalProfileRecord",
                    "InternalProjection",
                ]
            );
        });

        it("should barrel export the generated contract file", async () => {
            await expectFileContains(
                ctx.getOutputFile("public-contract/index.ts"),
                "export * from './contracts.js'"
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

        it("should keep PublicContract symbols when filtering messages to events", () => {
            expect(result.events).toHaveLength(0);
            expect(result.commands).toHaveLength(0);
            expect(result.queries).toHaveLength(0);
            expect(result.publicContracts).toHaveLength(4);
            expect(result.copiedFiles).toHaveLength(1);
            expectGeneratedFiles(ctx.getOutputDir(), "public-contract", [
                "index.ts",
                "contracts.ts",
            ]);
        });
    });

    describe("strict entry symbol extraction", () => {
        const ctx = new E2ETestContext("public-contract");
        let result: ProcessContextResult;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser();
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("should extract only marked PublicContract declarations", () => {
            expect(result.events).toHaveLength(0);
            expect(result.commands).toHaveLength(0);
            expect(result.queries).toHaveLength(0);
            expect(result.publicContracts).toHaveLength(4);
        });

        it("should extract target declarations and required runtime dependencies only", async () => {
            await expectFileContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "deriveDisplayName",
                    "DEFAULT_STATUS",
                    "Factory",
                    "Status",
                    "Factory.create()",
                    "Status.Active",
                ]
            );
            await expectFileNotContains(
                ctx.getOutputFile("public-contract/contracts.ts"),
                [
                    "InternalProfileRecord",
                    "InternalProjection",
                ]
            );
        });
    });

    describe("removeDecorators output", () => {
        it("should remove PublicContract decorators and decorator imports", async () => {
            const ctx = new E2ETestContext("public-contract");
            await ctx.setup();

            try {
                await ctx.runParser({
                    removeDecorators: true,
                });

                await expectFileNotContains(
                    ctx.getOutputFile("public-contract/contracts.ts"),
                    [
                        "@PublicContract",
                        "@hexaijs/contracts/decorators",
                    ]
                );
            } finally {
                await ctx.teardown();
            }
        });

        it("should compile output after preserving class implementation", async () => {
            const ctx = new E2ETestContext("public-contract");
            await ctx.setup();

            try {
                await ctx.runParser({
                    removeDecorators: true,
                });

                await expectTypeScriptCompiles(ctx.getOutputDir());
            } finally {
                await ctx.teardown();
            }
        });
    });
});
