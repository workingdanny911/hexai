import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    E2ETestContext,
    expectFileContains,
    expectFileNotContains,
    expectGeneratedFiles,
    expectTypeScriptCompiles,
    expectTypeScriptCompilesWithNodeNext,
} from "@e2e/helpers";
import type { ProcessContextResult } from "../../src/index.js";
import { runWithConfig } from "../../src/cli.js";

describe("E2E: Contract API", () => {
    describe("default extraction", () => {
        const ctx = new E2ETestContext("contract-api");
        let result: ProcessContextResult;
        let registryPath: string;

        beforeAll(async () => {
            await ctx.setup();
            result = await ctx.runParser({
                removeDecorators: true,
            });
            registryPath = await ctx.generateRegistry(result);
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("extracts Contract*, generic Contract message kinds, aliases, and legacy messages", () => {
            expect(result.commands.map((message) => message.name).sort()).toEqual([
                "CreateCatalogItemCommand",
                "LegacyPublishCatalogCommand",
                "RebuildCatalogIndexCommand",
                "RefreshCatalogCommand",
            ]);
            expect(result.queries.map((message) => message.name).sort()).toEqual([
                "GetCatalogSummaryQuery",
                "SearchCatalogQuery",
            ]);
            expect(result.events.map((message) => message.name).sort()).toEqual([
                "CatalogImportedEvent",
                "CatalogItemPublishedEvent",
            ]);
            expect(result.commands.map((message) => message.name)).not.toContain(
                "IgnoredFakeContractCommand"
            );
        });

        it("keeps marker metadata for visibility, tags, aliases, generic kinds, and legacy markers", () => {
            const byName = new Map(
                [...result.commands, ...result.queries, ...result.events].map(
                    (message) => [message.name, message]
                )
            );

            expect(byName.get("RebuildCatalogIndexCommand")).toMatchObject({
                visibility: "internal",
                tags: ["bus", "maintenance"],
                marker: {
                    name: "InternalCommand",
                    importedName: "ContractCommand",
                    localName: "InternalCommand",
                    canonicalName: "ContractCommand",
                },
            });
            expect(byName.get("RefreshCatalogCommand")).toMatchObject({
                messageType: "command",
                visibility: "internal",
                tags: ["bus"],
                marker: { canonicalName: "Contract", kind: "command" },
            });
            expect(byName.get("SearchCatalogQuery")).toMatchObject({
                resultType: { kind: "reference", name: "SearchCatalogResult" },
                marker: { canonicalName: "Contract", kind: "query" },
            });
            expect(byName.get("CatalogItemPublishedEvent")).toMatchObject({
                version: 2,
                marker: { canonicalName: "ContractEvent" },
            });
            expect(byName.get("LegacyPublishCatalogCommand")?.marker?.legacy).toBe(
                true
            );
        });

        it("extracts generic custom contracts and Contract comment marker options", () => {
            expect(result.publicContracts.map((contract) => contract.name).sort()).toEqual([
                "CatalogId",
                "CatalogReadModel",
                "CatalogSnapshot",
                "InternalCatalogStatus",
            ]);

            const byName = new Map(
                result.publicContracts.map((contract) => [contract.name, contract])
            );
            expect(byName.get("CatalogSnapshot")).toMatchObject({
                declarationKind: "class",
                kind: "snapshot",
                visibility: "public",
                tags: ["frontend"],
            });
            expect(byName.get("CatalogReadModel")).toMatchObject({
                declarationKind: "interface",
                kind: "read-model",
                marker: { syntax: "comment", canonicalName: "Contract" },
            });
            expect(byName.get("CatalogId")).toMatchObject({
                declarationKind: "type",
                kind: "value-object",
                marker: { syntax: "comment", canonicalName: "Contract" },
            });
            expect(byName.get("InternalCatalogStatus")).toMatchObject({
                declarationKind: "enum",
                kind: "status",
                visibility: "internal",
                tags: ["ops"],
            });
        });

        it("generates sources that compile and exclude untrusted same-name decorators", async () => {
            expectGeneratedFiles(ctx.getOutputDir(), "contract-api", [
                "messages.ts",
                "contracts.ts",
                "index.ts",
            ]);
            await expectFileContains(
                ctx.getOutputFile("contract-api", "messages.ts"),
                [
                    "CreateCatalogItemCommand",
                    "RebuildCatalogIndexCommand",
                    "SearchCatalogQuery",
                    "CatalogImportedEvent",
                    "LegacyPublishCatalogCommand",
                ]
            );
            await expectFileNotContains(
                ctx.getOutputFile("contract-api", "messages.ts"),
                "IgnoredFakeContractCommand"
            );
            await expectTypeScriptCompiles(ctx.getOutputFile("contract-api"));
        });

        it("generates sources that compile with NodeNext module resolution", async () => {
            await expectTypeScriptCompilesWithNodeNext(ctx.getOutputDir());
        });

        it("registers selected Contract* messages but not general/custom contracts", async () => {
            const registryContent = await readFile(registryPath, "utf-8");

            for (const messageName of [
                "CreateCatalogItemCommand",
                "RebuildCatalogIndexCommand",
                "RefreshCatalogCommand",
                "GetCatalogSummaryQuery",
                "SearchCatalogQuery",
                "CatalogItemPublishedEvent",
                "CatalogImportedEvent",
                "LegacyPublishCatalogCommand",
            ]) {
                expect(registryContent).toContain(`.register(${messageName})`);
            }

            for (const contractName of [
                "CatalogSnapshot",
                "CatalogReadModel",
                "CatalogId",
                "InternalCatalogStatus",
                "IgnoredFakeContractCommand",
            ]) {
                expect(registryContent).not.toContain(`.register(${contractName})`);
            }
        });
    });

    describe("visibility split and output-level registry", () => {
        const ctx = new E2ETestContext("contract-api");

        beforeAll(async () => {
            await ctx.setup();
            await runWithConfig(
                {},
                {
                    contexts: [
                        {
                            name: "catalog",
                            path: ctx.getFixtureDir(),
                        },
                    ],
                    entryStrategy: "symbols",
                    removeDecorators: true,
                    outputs: [
                        {
                            name: "public",
                            path: join(ctx.getOutputDir(), "public-contracts"),
                            select: { visibility: ["public"] },
                        },
                        {
                            name: "internal",
                            path: join(ctx.getOutputDir(), "internal-contracts"),
                            registry: true,
                            select: {
                                visibility: ["internal"],
                                messageKinds: ["command"],
                                tags: { include: ["bus"] },
                            },
                        },
                    ],
                }
            );
        });

        afterAll(async () => {
            await ctx.teardown();
        });

        it("writes public output with only public declarations", async () => {
            const publicDir = ctx.getOutputFile("public-contracts", "catalog");

            await expectFileContains(join(publicDir, "messages.ts"), [
                "CreateCatalogItemCommand",
                "GetCatalogSummaryQuery",
                "SearchCatalogQuery",
                "CatalogItemPublishedEvent",
                "CatalogImportedEvent",
                "LegacyPublishCatalogCommand",
            ]);
            await expectFileContains(join(publicDir, "contracts.ts"), [
                "CatalogSnapshot",
                "CatalogReadModel",
                "CatalogId",
            ]);
            await expectFileNotContains(join(publicDir, "messages.ts"), [
                "RebuildCatalogIndexCommand",
                "RefreshCatalogCommand",
                "InternalCatalogWorker",
                "InternalRebuildPlan",
                "IgnoredFakeContractCommand",
            ]);
            await expectFileNotContains(join(publicDir, "contracts.ts"), [
                "InternalCatalogStatus",
                "PrivateCatalogProjection",
            ]);
            await expectTypeScriptCompiles(publicDir);
        });

        it("writes internal command output selected by visibility, messageKinds, and tags", async () => {
            const internalDir = ctx.getOutputFile("internal-contracts", "catalog");

            await expectFileContains(join(internalDir, "messages.ts"), [
                "RebuildCatalogIndexCommand",
                "RefreshCatalogCommand",
                "InternalRebuildPlan",
            ]);
            await expectFileNotContains(join(internalDir, "messages.ts"), [
                "CreateCatalogItemCommand",
                "GetCatalogSummaryQuery",
                "CatalogItemPublishedEvent",
                "CatalogSnapshot",
                "InternalCatalogWorker",
                "IgnoredFakeContractCommand",
            ]);
            await expectTypeScriptCompiles(internalDir);
        });

        it("generates a registry only for the configured output and selected messages", () => {
            const publicRegistry = join(ctx.getOutputDir(), "public-contracts", "index.ts");
            const internalRegistry = join(
                ctx.getOutputDir(),
                "internal-contracts",
                "index.ts"
            );

            expect(existsSync(publicRegistry)).toBe(false);
            expect(existsSync(internalRegistry)).toBe(true);

            const registryContent = readFileSync(internalRegistry, "utf-8");
            expect(registryContent).toContain(".register(catalog.RebuildCatalogIndexCommand)");
            expect(registryContent).toContain(".register(catalog.RefreshCatalogCommand)");
            expect(registryContent).not.toContain("CreateCatalogItemCommand");
            expect(registryContent).not.toContain("CatalogSnapshot");
        });
    });
});
