import { describe, expect, it, test } from "vitest";
import { Message } from "./message.js";

describe("Message", () => {
    it("deserializes date string to Date object - for timestamp", () => {
        const createdAt = new Date();

        const message = Message.from(
            {},
            {
                id: "message-id",
                type: "dummy",
                createdAt: createdAt.toISOString(),
            }
        );

        expect(message.getTimestamp()).toEqual(createdAt);
    });

    test("when modifying the message, returns a new instance", () => {
        const message = new Message({
            foo: "bar",
        });

        const headerAdded = message.withHeader("new-header", "header-value");
        expect(headerAdded).not.toBe(message);
        expect(headerAdded.getHeader("new-header")).toBe("header-value");
        expect(message.getHeader("new-header")).toBeUndefined();
    });

    describe("toJSON", () => {
        it("is used by JSON.stringify automatically", () => {
            const message = new Message({ foo: "bar" });
            const json = JSON.parse(JSON.stringify(message));

            expect(json).toHaveProperty("headers");
            expect(json).toHaveProperty("payload");
            expect(json.payload).toEqual({ foo: "bar" });
            expect(json.headers.type).toBe("Message");
        });
    });

    describe("immutability", () => {
        it("should freeze headers so external mutation is prevented", () => {
            const message = new Message({ foo: "bar" });
            const headers = message.getHeaders();

            expect(() => {
                headers.id = "mutated-id";
            }).toThrow();
        });

        it("should freeze payload so external mutation is prevented", () => {
            const message = new Message({ foo: "bar" });
            const payload = message.getPayload();

            expect(() => {
                (payload as any).foo = "mutated";
            }).toThrow();
        });

        it("should copy object payload before freezing it", () => {
            const nested = { count: 1 };
            const originalPayload = { foo: "bar", nested };

            const message = new Message(originalPayload);
            const payload = message.getPayload();

            expect(payload).not.toBe(originalPayload);
            expect(payload.nested).toBe(nested);
            expect(Object.isFrozen(originalPayload)).toBe(false);
            expect(Object.isFrozen(payload)).toBe(true);

            originalPayload.foo = "mutated";
            expect(payload.foo).toBe("bar");
        });

        it("should shallow copy array payload containers", () => {
            const nested = { id: "nested" };
            const originalPayload = [nested];

            const message = new Message(originalPayload);
            const payload = message.getPayload();

            expect(Array.isArray(payload)).toBe(true);
            expect(payload).not.toBe(originalPayload);
            expect(payload[0]).toBe(nested);
            expect(Object.isFrozen(originalPayload)).toBe(false);
            expect(Object.isFrozen(payload)).toBe(true);

            originalPayload.push({ id: "added" });
            expect(payload).toHaveLength(1);
        });

        it("setHeader should use structural sharing (payload reference unchanged)", () => {
            const originalPayload = { foo: "bar" };
            const message = new Message(originalPayload);
            const modified = message.withHeader("custom", "value");

            // structural sharing: payload should be same reference
            expect(modified.getPayload()).toBe(message.getPayload());
        });

        it("setHeader should not deep clone headers unnecessarily", () => {
            const message = new Message({ foo: "bar" });
            const modified = message.withHeader("custom", "value");

            // original headers properties should be preserved
            expect(modified.getMessageId()).toBe(message.getMessageId());
            expect(modified.getMessageType()).toBe(message.getMessageType());
            expect(modified.getTimestamp()).toBe(message.getTimestamp());
        });
    });
});
