import { describe, test, expect, beforeEach } from "vitest";

import { MessageRegistry, MessageClass, MessageHeaders } from "./message-registry";

describe("MessageRegistry", () => {
    let registry: MessageRegistry;

    beforeEach(() => {
        registry = new MessageRegistry();
    });

    function createMessageClass(
        type: string,
        schemaVersion?: string | number
    ): MessageClass {
        return class TestMessage {
            static type = type;
            static schemaVersion = schemaVersion;

            static getType() {
                return this.type;
            }

            static getSchemaVersion() {
                return this.schemaVersion;
            }

            static from(payload: Record<string, unknown>, headers?: MessageHeaders) {
                return new this(payload, { headers });
            }

            constructor(
                public readonly payload: Record<string, unknown>,
                public readonly options?: { headers?: MessageHeaders }
            ) {}
        } as unknown as MessageClass;
    }

    function createHeaders(type: string, schemaVersion?: string | number): MessageHeaders {
        return {
            id: "test-id",
            type,
            schemaVersion,
            createdAt: new Date(),
        };
    }

    test("registers and dehydrates a message", () => {
        const TestMessage = createMessageClass("test.message");
        registry.register(TestMessage);

        const result = registry.dehydrate(
            createHeaders("test.message"),
            { foo: "bar" }
        );

        expect(result).toBeInstanceOf(TestMessage);
        expect((result as any).payload).toEqual({ foo: "bar" });
    });

    test("registers multiple message types", () => {
        const MessageA = createMessageClass("type-a");
        const MessageB = createMessageClass("type-b");

        registry.register(MessageA).register(MessageB);

        expect(registry.dehydrate(createHeaders("type-a"), {})).toBeInstanceOf(MessageA);
        expect(registry.dehydrate(createHeaders("type-b"), {})).toBeInstanceOf(MessageB);
    });

    test("handles versioned messages", () => {
        const V1 = createMessageClass("versioned.message");
        const V2 = createMessageClass("versioned.message", 2);

        registry.register(V1).register(V2);

        expect(registry.dehydrate(createHeaders("versioned.message"), {})).toBeInstanceOf(V1);
        expect(registry.dehydrate(createHeaders("versioned.message", 2), {})).toBeInstanceOf(V2);
    });

    test("throws when registering duplicate type", () => {
        const Message1 = createMessageClass("duplicate.type");
        const Message2 = createMessageClass("duplicate.type");

        registry.register(Message1);

        expect(() => registry.register(Message2)).toThrow(/'duplicate\.type'.*already registered/);
    });

    test("throws when registering duplicate versioned type", () => {
        const V1a = createMessageClass("versioned.type", 1);
        const V1b = createMessageClass("versioned.type", 1);

        registry.register(V1a);

        expect(() => registry.register(V1b)).toThrow(/'versioned\.type'.*v1.*already registered/);
    });

    test("throws when dehydrating unregistered type", () => {
        expect(() => registry.dehydrate(createHeaders("unknown.type"), {}))
            .toThrow(/'unknown\.type'.*not registered/);
    });

    test("has() checks if message type is registered", () => {
        const TestMessage = createMessageClass("check.type");

        expect(registry.has("check.type")).toBe(false);

        registry.register(TestMessage);

        expect(registry.has("check.type")).toBe(true);
        expect(registry.has("other.type")).toBe(false);
    });

    test("has() checks versioned message types", () => {
        const V2 = createMessageClass("versioned.check", 2);

        registry.register(V2);

        expect(registry.has("versioned.check")).toBe(false);
        expect(registry.has("versioned.check", 2)).toBe(true);
        expect(registry.has("versioned.check", 1)).toBe(false);
    });

    test("size() returns number of registered messages", () => {
        expect(registry.size()).toBe(0);

        registry.register(createMessageClass("type-1"));
        expect(registry.size()).toBe(1);

        registry.register(createMessageClass("type-2"));
        expect(registry.size()).toBe(2);
    });

    test("preserves headers during dehydration", () => {
        const TestMessage = createMessageClass("headers.test");
        registry.register(TestMessage);

        const headers = createHeaders("headers.test");
        const result = registry.dehydrate(headers, {}) as any;

        expect(result.options.headers).toBe(headers);
    });

    test("handles string schema versions", () => {
        const V1_0 = createMessageClass("test.message", "1.0");
        const V2_0 = createMessageClass("test.message", "2.0");

        registry.register(V1_0).register(V2_0);

        expect(registry.dehydrate(createHeaders("test.message", "1.0"), {})).toBeInstanceOf(V1_0);
        expect(registry.dehydrate(createHeaders("test.message", "2.0"), {})).toBeInstanceOf(V2_0);
    });

    test("throws when dehydrating wrong version", () => {
        const V1 = createMessageClass("test.message");
        registry.register(V1);

        expect(() => registry.dehydrate(createHeaders("test.message", 2), {}))
            .toThrow(/not registered/);
    });
});
