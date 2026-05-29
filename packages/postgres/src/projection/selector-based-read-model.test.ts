import { describe, it, expect, vi } from "vitest";

import { Message } from "@hexaijs/core";

import { SelectorBasedReadModel } from "./selector-based-read-model.js";
import { eventTypeMatches } from "./selector.js";

import type { ClientBase } from "pg";
import type { StoredEvent } from "@hexaijs/core";

function createStoredEvent(type: string, position = 1): StoredEvent {
    return {
        position,
        event: new Message({}, { headers: { type } }),
    };
}

function createFakeClient(): ClientBase {
    return { query: vi.fn() } as unknown as ClientBase;
}

function createTestModel(
    selectors: Array<{ method: string; type: string | string[] | RegExp }>,
    methods: Record<string, (...args: any[]) => Promise<void>>
): SelectorBasedReadModel {
    class TestModel extends SelectorBasedReadModel {
        readonly name = "test";
        readonly version = 1;
        async reset() {}
    }

    for (const { method, type } of selectors) {
        TestModel.registerSelector({
            method,
            predicate: eventTypeMatches(type),
        });
    }

    const model = new TestModel();
    for (const [name, fn] of Object.entries(methods)) {
        (model as any)[name] = fn;
    }

    return model;
}

describe("SelectorBasedReadModel", () => {
    describe("canHandle", () => {
        it("returns true for registered event types", () => {
            const model = createTestModel(
                [{ method: "onOrder", type: "order.created" }],
                { onOrder: vi.fn() }
            );

            expect(model.canHandle(createStoredEvent("order.created"))).toBe(
                true
            );
        });

        it("returns false for unregistered event types", () => {
            const model = createTestModel(
                [{ method: "onOrder", type: "order.created" }],
                { onOrder: vi.fn() }
            );

            expect(model.canHandle(createStoredEvent("order.deleted"))).toBe(
                false
            );
        });

        it("returns false when no selectors are registered", () => {
            class EmptyModel extends SelectorBasedReadModel {
                readonly name = "empty";
                readonly version = 1;
                async reset() {}
            }

            const model = new EmptyModel();

            expect(model.canHandle(createStoredEvent("anything"))).toBe(false);
        });
    });

    describe("apply", () => {
        it("dispatches to the matching handler method", async () => {
            const spy = vi.fn();
            const model = createTestModel(
                [{ method: "onOrderCreated", type: "order.created" }],
                { onOrderCreated: spy }
            );

            const client = createFakeClient();
            const event = createStoredEvent("order.created", 42);

            await model.apply(event, client);

            expect(spy).toHaveBeenCalledWith(event, client);
        });

        it("passes stored event position to handler methods", async () => {
            const positions: number[] = [];
            const model = createTestModel(
                [{ method: "onOrderCreated", type: "order.created" }],
                {
                    onOrderCreated: vi.fn(async (storedEvent: StoredEvent) => {
                        positions.push(storedEvent.position);
                    }),
                }
            );

            await model.apply(
                createStoredEvent("order.created", 123),
                createFakeClient()
            );

            expect(positions).toEqual([123]);
        });

        it("does nothing when no handler matches", async () => {
            const spy = vi.fn();
            const model = createTestModel(
                [{ method: "onOrder", type: "order.created" }],
                { onOrder: spy }
            );

            await model.apply(
                createStoredEvent("order.deleted"),
                createFakeClient()
            );

            expect(spy).not.toHaveBeenCalled();
        });

        it("throws when multiple handlers match the same event", async () => {
            const model = createTestModel(
                [
                    { method: "handlerA", type: "order.created" },
                    { method: "handlerB", type: "order.created" },
                ],
                { handlerA: vi.fn(), handlerB: vi.fn() }
            );

            await expect(
                model.apply(
                    createStoredEvent("order.created"),
                    createFakeClient()
                )
            ).rejects.toThrow(
                "Multiple handling methods selected for event 'order.created'"
            );
        });
    });

    describe("subclass isolation", () => {
        it("does not share selectors between sibling subclasses", () => {
            class ModelA extends SelectorBasedReadModel {
                readonly name = "a";
                readonly version = 1;
                async onA() {}
                async reset() {}
            }
            ModelA.registerSelector({
                method: "onA",
                predicate: eventTypeMatches("event.a"),
            });

            class ModelB extends SelectorBasedReadModel {
                readonly name = "b";
                readonly version = 1;
                async onB() {}
                async reset() {}
            }
            ModelB.registerSelector({
                method: "onB",
                predicate: eventTypeMatches("event.b"),
            });

            const a = new ModelA();
            const b = new ModelB();

            expect(a.canHandle(createStoredEvent("event.a"))).toBe(true);
            expect(a.canHandle(createStoredEvent("event.b"))).toBe(false);

            expect(b.canHandle(createStoredEvent("event.b"))).toBe(true);
            expect(b.canHandle(createStoredEvent("event.a"))).toBe(false);
        });
    });

    describe("eventTypeMatches", () => {
        it("supports array of types", () => {
            const model = createTestModel(
                [
                    {
                        method: "onOrder",
                        type: ["order.created", "order.updated"],
                    },
                ],
                { onOrder: vi.fn() }
            );

            expect(model.canHandle(createStoredEvent("order.created"))).toBe(
                true
            );
            expect(model.canHandle(createStoredEvent("order.updated"))).toBe(
                true
            );
            expect(model.canHandle(createStoredEvent("order.deleted"))).toBe(
                false
            );
        });

        it("supports regex patterns", () => {
            const model = createTestModel(
                [{ method: "onOrder", type: /^order\./ }],
                { onOrder: vi.fn() }
            );

            expect(model.canHandle(createStoredEvent("order.created"))).toBe(
                true
            );
            expect(model.canHandle(createStoredEvent("order.updated"))).toBe(
                true
            );
            expect(model.canHandle(createStoredEvent("user.created"))).toBe(
                false
            );
        });
    });
});
