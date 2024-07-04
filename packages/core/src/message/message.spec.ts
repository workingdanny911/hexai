import { describe, expect, it } from "vitest";
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
});
