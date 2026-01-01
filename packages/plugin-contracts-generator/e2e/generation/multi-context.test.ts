import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { ProcessContextResult } from "@/index";
import {
    E2ETestContext,
    expectTypeScriptCompiles,
    expectGeneratedFiles,
    expectFileContains,
    expectFileNotContains,
} from "@e2e/helpers";

describe("E2E: Multi-Context", () => {
    const ctx = new E2ETestContext("multi-context");
    let ordersResult: ProcessContextResult;
    let inventoryResult: ProcessContextResult;

    beforeAll(async () => {
        await ctx.setup();

        const results = await ctx.runParserForContexts([
            { contextName: "orders", sourceSubPath: "orders" },
            { contextName: "inventory", sourceSubPath: "inventory" },
        ]);

        ordersResult = results.get("orders")!;
        inventoryResult = results.get("inventory")!;
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Orders Context", () => {
        it("should extract order events", () => {
            expect(ordersResult.events).toHaveLength(3);
            const eventNames = ordersResult.events.map((e) => e.name);
            expect(eventNames).toContain("OrderCreated");
            expect(eventNames).toContain("OrderStatusChanged");
            expect(eventNames).toContain("OrderCancelled");
        });

        it("should extract order commands", () => {
            expect(ordersResult.commands).toHaveLength(2);
            const commandNames = ordersResult.commands.map((c) => c.name);
            expect(commandNames).toContain("CreateOrder");
            expect(commandNames).toContain("CancelOrder");
        });

        it("should copy source files and dependencies", () => {
            expect(ordersResult.copiedFiles.length).toBeGreaterThanOrEqual(3);
        });

        it("should generate all required files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "orders", [
                "events.ts",
                "commands.ts",
                "types.ts",
                "index.ts",
            ]);
        });

        it("should compile without TypeScript errors", async () => {
            await expectTypeScriptCompiles(ctx.getOutputFile("orders"));
        });
    });

    describe("Inventory Context", () => {
        it("should extract inventory events", () => {
            expect(inventoryResult.events).toHaveLength(3);
            const eventNames = inventoryResult.events.map((e) => e.name);
            expect(eventNames).toContain("StockReceived");
            expect(eventNames).toContain("StockReserved");
            expect(eventNames).toContain("StockAdjusted");
        });

        it("should extract inventory commands", () => {
            expect(inventoryResult.commands).toHaveLength(3);
            const commandNames = inventoryResult.commands.map((c) => c.name);
            expect(commandNames).toContain("ReceiveStock");
            expect(commandNames).toContain("ReserveStock");
            expect(commandNames).toContain("AdjustStock");
        });

        it("should copy source files and dependencies", () => {
            expect(inventoryResult.copiedFiles.length).toBeGreaterThanOrEqual(
                3
            );
        });

        it("should generate all required files", () => {
            expectGeneratedFiles(ctx.getOutputDir(), "inventory", [
                "events.ts",
                "commands.ts",
                "types.ts",
                "index.ts",
            ]);
        });

        it("should compile without TypeScript errors", async () => {
            await expectTypeScriptCompiles(ctx.getOutputFile("inventory"));
        });
    });

    describe("Context Independence", () => {
        it("orders should not have inventory-specific imports", async () => {
            await expectFileNotContains(
                ctx.getOutputFile("orders", "events.ts"),
                ["WarehouseId", "StockLevel"]
            );
        });

        it("inventory should not have orders-specific imports", async () => {
            await expectFileNotContains(
                ctx.getOutputFile("inventory", "events.ts"),
                ["OrderItem", "ShippingAddress"]
            );
        });
    });

    describe("Local Types", () => {
        it("orders types.ts should contain order-specific types", async () => {
            await expectFileContains(ctx.getOutputFile("orders", "types.ts"), [
                "export type OrderItem",
                "export type OrderStatus",
            ]);
        });

        it("inventory types.ts should contain inventory-specific types", async () => {
            await expectFileContains(
                ctx.getOutputFile("inventory", "types.ts"),
                ["export type WarehouseId", "export type StockLevel"]
            );
        });
    });
});
