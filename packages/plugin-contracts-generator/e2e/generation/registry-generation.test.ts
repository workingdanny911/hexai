import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";

import { E2ETestContext } from "../helpers/test-context";

describe("Registry Generation E2E", () => {
    let ctx: E2ETestContext;

    beforeEach(async () => {
        ctx = new E2ETestContext("registry");
        await ctx.setup();
    });

    afterEach(async () => {
        await ctx.teardown();
    });

    describe("registry.ts generation", () => {
        it("should generate registry.ts with MessageRegistry import", async () => {
            const result = await ctx.runParser();
            const registryPath = await ctx.generateRegistry(result);
            const content = await readFile(registryPath, "utf-8");

            expect(content).toContain(
                'import { MessageRegistry } from "@hexaijs/plugin-contracts-generator/runtime"'
            );
        });

        it("should generate registry with imports from context", async () => {
            const result = await ctx.runParser();
            const registryPath = await ctx.generateRegistry(result);
            const content = await readFile(registryPath, "utf-8");

            expect(content).toContain('from "./registry"');
            expect(content).toContain("UserRegistered");
            expect(content).toContain("UserRegistered_V2");
            expect(content).toContain("OrderPlaced");
            expect(content).toContain("RegisterUser");
            expect(content).toContain("PlaceOrder");
            expect(content).toContain("GetUserById");
            expect(content).toContain("GetOrderHistory");
        });

        it("should generate registry with .register() calls for each message", async () => {
            const result = await ctx.runParser();
            const registryPath = await ctx.generateRegistry(result);
            const content = await readFile(registryPath, "utf-8");

            expect(content).toContain(".register(UserRegistered)");
            expect(content).toContain(".register(UserRegistered_V2)");
            expect(content).toContain(".register(OrderPlaced)");
            expect(content).toContain(".register(RegisterUser)");
            expect(content).toContain(".register(PlaceOrder)");
            expect(content).toContain(".register(GetUserById)");
            expect(content).toContain(".register(GetOrderHistory)");
        });

        it("should export messageRegistry", async () => {
            const result = await ctx.runParser();
            const registryPath = await ctx.generateRegistry(result);
            const content = await readFile(registryPath, "utf-8");

            expect(content).toContain(
                "export const messageRegistry = new MessageRegistry()"
            );
        });

        it("should use chained .register() syntax", async () => {
            const result = await ctx.runParser();
            const registryPath = await ctx.generateRegistry(result);
            const content = await readFile(registryPath, "utf-8");

            // Should be chained, not separate statements
            expect(content).toMatch(/new MessageRegistry\(\)\s+\.register\(/);
            expect(content).toMatch(/\.register\([^)]+\)\s+\.register\(/);
        });
    });

    describe("multi-context registry", () => {
        let multiCtx: E2ETestContext;

        beforeEach(async () => {
            multiCtx = new E2ETestContext("multi-context");
            await multiCtx.setup();
        });

        afterEach(async () => {
            await multiCtx.teardown();
        });

        it("should generate registry with imports from all contexts", async () => {
            const results = await multiCtx.runParserForContexts([
                { contextName: "orders", sourceSubPath: "orders" },
                { contextName: "inventory", sourceSubPath: "inventory" },
            ]);

            const registryPath = await multiCtx.generateRegistry(results);
            const content = await readFile(registryPath, "utf-8");

            expect(content).toContain('from "./orders"');
            expect(content).toContain('from "./inventory"');
        });

        it("should include messages from all contexts in registry", async () => {
            const results = await multiCtx.runParserForContexts([
                { contextName: "orders", sourceSubPath: "orders" },
                { contextName: "inventory", sourceSubPath: "inventory" },
            ]);

            const registryPath = await multiCtx.generateRegistry(results);
            const content = await readFile(registryPath, "utf-8");

            // Orders context
            expect(content).toContain(".register(OrderCreated)");
            expect(content).toContain(".register(CreateOrder)");

            // Inventory context
            expect(content).toContain(".register(StockReceived)");
            expect(content).toContain(".register(ReceiveStock)");
        });
    });
});
