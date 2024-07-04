import { describe, expect, test } from "vitest";

import { Message } from "@/message";
import { expectMessageToMatch } from "./matchers";

describe("expectMessageToMatch", () => {
    test("with empty set, should throw", () => {
        const emptySet: Message[] = [];

        expect(() =>
            expectMessageToMatch(emptySet, Message, {})
        ).toThrowError();
    });

    test("with empty message", () => {
        const setContainingEmptyMessage = [new Message({})];

        expectMessageToMatch(setContainingEmptyMessage, Message, {});
    });

    test("with message with simple data", () => {
        const set = [
            new Message({
                payload: "dummy",
            }),
        ];

        expectMessageToMatch(set, Message, { payload: "dummy" });
    });

    test("with message with same payload, but different type, should throw", () => {
        const set = [
            new Message({
                payload: "dummy",
            }),
        ];

        expect(() =>
            expectMessageToMatch(set, "other-type", { payload: "dummy" })
        ).toThrowError();
    });

    test("with message with same type, but different payload, should throw", () => {
        const set = [
            new Message({
                key: "value1",
            }),
        ];

        expect(() =>
            expectMessageToMatch(set, Message, { key: "value2" })
        ).toThrowError();
    });

    test("with message with partial payload", () => {
        const set = [
            new Message({
                key1: "value1",
                key2: "value2",
            }),
        ];
        const partialPayload = { key1: "value1" };

        expectMessageToMatch(set, Message, partialPayload);
    });

    test("with message with nested partial payload", () => {
        const set = [
            new Message({
                key: {
                    key1: "value1",
                    key2: "value2",
                },
            }),
        ];
        const partialPayload = { key: { key2: "value2" } };

        expectMessageToMatch(set, Message, partialPayload);
    });

    test("with message with nested partial payload, but different value, should throw", () => {
        const set = [
            new Message({
                key: {
                    key1: "value1",
                    key2: "value2",
                },
            }),
        ];
        const partialPayload = { key: { key2: "value3" } };

        expect(() =>
            expectMessageToMatch(set, Message, partialPayload)
        ).toThrowError();
    });

    test("with message with payload in array", () => {
        const set = [
            new Message({
                key: ["value1", "value2"],
            }),
        ];
        const partialPayload = { key: ["value1"] };

        expectMessageToMatch(set, Message, partialPayload);
    });

    test("with message with nested partial payload in array", () => {
        const set = [
            new Message({
                key: [
                    {
                        key1: "value1",
                        key2: "value2",
                    },
                    {
                        key1: "value3",
                        key2: "value4",
                    },
                ],
            }),
        ];
        const partialPayload = {
            key: [
                { key1: "value1" },
                {
                    key2: "value4",
                },
            ],
        };

        expectMessageToMatch(set, Message, partialPayload);
    });
});
