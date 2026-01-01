import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { E2ETestContext, importGeneratedModule } from "../helpers";

describe("Runtime: Multi Context", () => {
    const ctx = new E2ETestContext("multi-context");

    beforeAll(async () => {
        await ctx.setup();

        await ctx.runParserForContexts([
            { contextName: "orders", sourceSubPath: "orders" },
            { contextName: "inventory", sourceSubPath: "inventory" },
        ]);
    });

    afterAll(async () => {
        await ctx.teardown();
    });

    describe("Orders Context", () => {
        describe("CreateOrder Command", () => {
            it("should instantiate with order items and shipping address", async () => {
                const { CreateOrder } = await importGeneratedModule<{
                    CreateOrder: new (payload: Record<string, unknown>) => {
                        getPayload(): {
                            customerId: string;
                            items: unknown[];
                            shippingAddress: Record<string, unknown>;
                        };
                    };
                }>(ctx.getOutputFile("orders", "commands.ts"));

                const cmd = new CreateOrder({
                    customerId: "customer-123",
                    items: [
                        { productId: "prod-1", quantity: 2, price: { amount: 100, currency: "USD" } },
                        { productId: "prod-2", quantity: 1, price: { amount: 50, currency: "USD" } },
                    ],
                    shippingAddress: {
                        street: "123 Main St",
                        city: "Seoul",
                        country: "Korea",
                        zipCode: "12345",
                    },
                });

                const payload = cmd.getPayload();
                expect(payload.customerId).toBe("customer-123");
                expect(payload.items).toHaveLength(2);
                expect(payload.shippingAddress.city).toBe("Seoul");
            });
        });

        describe("CancelOrder Command", () => {
            it("should instantiate with order ID and reason", async () => {
                const { CancelOrder } = await importGeneratedModule<{
                    CancelOrder: new (payload: Record<string, unknown>) => {
                        getPayload(): { orderId: string; reason: string };
                    };
                }>(ctx.getOutputFile("orders", "commands.ts"));

                const cmd = new CancelOrder({
                    orderId: "order-456",
                    reason: "Customer requested cancellation",
                });

                const payload = cmd.getPayload();
                expect(payload.orderId).toBe("order-456");
                expect(payload.reason).toBe("Customer requested cancellation");
            });
        });

        describe("OrderCreated Event", () => {
            it("should instantiate with order details", async () => {
                const { OrderCreated } = await importGeneratedModule<{
                    OrderCreated: new (payload: Record<string, unknown>) => {
                        getPayload(): { orderId: string };
                    };
                }>(ctx.getOutputFile("orders", "events.ts"));

                const event = new OrderCreated({
                    orderId: "order-789",
                    customerId: "customer-123",
                    items: [],
                    totalAmount: { amount: 150, currency: "USD" },
                    createdAt: Date.now(),
                });

                const payload = event.getPayload();
                expect(payload.orderId).toBe("order-789");
            });
        });
    });

    describe("Inventory Context", () => {
        describe("ReceiveStock Command", () => {
            it("should instantiate with stock details", async () => {
                const { ReceiveStock } = await importGeneratedModule<{
                    ReceiveStock: new (payload: Record<string, unknown>) => {
                        getPayload(): {
                            productId: string;
                            warehouseId: string;
                            quantity: { value: number; unit: string };
                        };
                    };
                }>(ctx.getOutputFile("inventory", "commands.ts"));

                const cmd = new ReceiveStock({
                    productId: "product-123",
                    warehouseId: "warehouse-A",
                    quantity: { value: 100, unit: "pieces" },
                });

                const payload = cmd.getPayload();
                expect(payload.productId).toBe("product-123");
                expect(payload.warehouseId).toBe("warehouse-A");
                expect(payload.quantity.value).toBe(100);
            });
        });

        describe("ReserveStock Command", () => {
            it("should instantiate with reservation details", async () => {
                const { ReserveStock } = await importGeneratedModule<{
                    ReserveStock: new (payload: Record<string, unknown>) => {
                        getPayload(): {
                            productId: string;
                            orderId: string;
                        };
                    };
                }>(ctx.getOutputFile("inventory", "commands.ts"));

                const cmd = new ReserveStock({
                    productId: "product-123",
                    warehouseId: "warehouse-A",
                    quantity: { value: 10, unit: "pieces" },
                    orderId: "order-456",
                });

                const payload = cmd.getPayload();
                expect(payload.productId).toBe("product-123");
                expect(payload.orderId).toBe("order-456");
            });
        });

        describe("AdjustStock Command", () => {
            it("should instantiate with adjustment details", async () => {
                const { AdjustStock } = await importGeneratedModule<{
                    AdjustStock: new (payload: Record<string, unknown>) => {
                        getPayload(): {
                            reason: string;
                        };
                    };
                }>(ctx.getOutputFile("inventory", "commands.ts"));

                const cmd = new AdjustStock({
                    productId: "product-123",
                    warehouseId: "warehouse-A",
                    adjustment: { value: -5, unit: "pieces" },
                    reason: "damaged",
                });

                const payload = cmd.getPayload();
                expect(payload.reason).toBe("damaged");
            });
        });

        describe("StockReceived Event", () => {
            it("should instantiate with stock received details", async () => {
                const { StockReceived } = await importGeneratedModule<{
                    StockReceived: new (payload: Record<string, unknown>) => {
                        getPayload(): { productId: string };
                    };
                }>(ctx.getOutputFile("inventory", "events.ts"));

                const event = new StockReceived({
                    productId: "product-123",
                    warehouseId: "warehouse-A",
                    quantity: { value: 100, unit: "pieces" },
                    receivedAt: Date.now(),
                });

                const payload = event.getPayload();
                expect(payload.productId).toBe("product-123");
            });
        });
    });

    describe("Context Independence", () => {
        it("should import orders context independently", async () => {
            const ordersModule = await importGeneratedModule<Record<string, unknown>>(
                ctx.getOutputFile("orders", "index.ts")
            );

            expect(ordersModule.CreateOrder).toBeDefined();
            expect(ordersModule.CancelOrder).toBeDefined();
            expect(ordersModule.OrderCreated).toBeDefined();
        });

        it("should import inventory context independently", async () => {
            const inventoryModule = await importGeneratedModule<Record<string, unknown>>(
                ctx.getOutputFile("inventory", "index.ts")
            );

            expect(inventoryModule.ReceiveStock).toBeDefined();
            expect(inventoryModule.ReserveStock).toBeDefined();
            expect(inventoryModule.AdjustStock).toBeDefined();
            expect(inventoryModule.StockReceived).toBeDefined();
        });
    });
});
