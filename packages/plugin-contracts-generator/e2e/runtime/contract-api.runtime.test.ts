import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers/index.js";
import { expectTypeScriptCompiles } from "../helpers/typescript-validator.js";
import type { ProcessContextResult } from "../../src/index.js";

describe("Runtime: Contract API generated output", () => {
    const ctx = new E2ETestContext("contract-api");
    let result: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();
        result = await ctx.runParser({
            removeDecorators: true,
        });
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    it("compiles generated Contract* output", async () => {
        expect(result.commands).toHaveLength(4);
        expect(result.queries).toHaveLength(2);
        expect(result.events).toHaveLength(2);
        expect(result.publicContracts).toHaveLength(4);

        await expectTypeScriptCompiles(ctx.getOutputFile("contract-api"));
    });

    it("loads generated message classes and preserves Message runtime behavior", async () => {
        const messages = await importGeneratedModule<{
            CreateCatalogItemCommand: new (payload: Record<string, unknown>) => {
                getPayload(): Record<string, unknown>;
            };
            SearchCatalogQuery: new (payload: Record<string, unknown>) => {
                getPayload(): Record<string, unknown>;
            };
            CatalogImportedEvent: new (payload: Record<string, unknown>) => {
                getPayload(): Record<string, unknown>;
            };
        }>(ctx.getOutputFile("contract-api", "messages.ts"));

        const command = new messages.CreateCatalogItemCommand({
            item: { sku: "sku-1", title: "Introduction" },
        });
        const query = new messages.SearchCatalogQuery({ term: "intro" });
        const event = new messages.CatalogImportedEvent({
            importedAt: "2026-06-01T00:00:00.000Z",
        });

        expect(command.getPayload().item).toEqual({
            sku: "sku-1",
            title: "Introduction",
        });
        expect(query.getPayload().term).toBe("intro");
        expect(event.getPayload().importedAt).toBe("2026-06-01T00:00:00.000Z");
    });

    it("loads generated general contract classes", async () => {
        const contracts = await importGeneratedModule<{
            CatalogSnapshot: new (items: readonly string[]) => {
                items: readonly string[];
            };
        }>(ctx.getOutputFile("contract-api", "contracts.ts"));

        const snapshot = new contracts.CatalogSnapshot(["sku-1", "sku-2"]);

        expect(snapshot.items).toEqual(["sku-1", "sku-2"]);
    });
});
