import { describe, expect, it, test } from "vitest";
import { Message } from "./message";

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
