import { describe, expect, test } from "vitest";

import { Message } from "@/message";
import {
    expectMessageToMatch,
    expectMessagesToBeFullyEqual,
    expectMessagesToContain,
} from "./matchers";

class OrderPlaced extends Message<{ orderId: string; amount: number }> {
    static getType() {
        return "OrderPlaced";
    }
}

class PaymentReceived extends Message<{ paymentId: string }> {
    static getType() {
        return "PaymentReceived";
    }
}

describe("expectMessagesToBeFullyEqual", () => {
    test("passes when both arrays are empty", () => {
        expectMessagesToBeFullyEqual([], []);
    });

    test("passes when messages are identical instances", () => {
        const order = new OrderPlaced({ orderId: "1", amount: 100 });
        const payment = new PaymentReceived({ paymentId: "p1" });
        const messages = [order, payment];

        expectMessagesToBeFullyEqual(messages, [order, payment]);
    });

    test("fails when message count differs", () => {
        const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];
        const expected = [
            new OrderPlaced({ orderId: "1", amount: 100 }),
            new PaymentReceived({ paymentId: "p1" }),
        ];

        expect(() => expectMessagesToBeFullyEqual(messages, expected)).toThrowError();
    });

    test("fails when message types differ", () => {
        const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];
        const expected = [new PaymentReceived({ paymentId: "p1" })];

        expect(() => expectMessagesToBeFullyEqual(messages, expected)).toThrowError();
    });

    test("fails when payloads differ", () => {
        const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];
        const expected = [new OrderPlaced({ orderId: "1", amount: 200 })];

        expect(() => expectMessagesToBeFullyEqual(messages, expected)).toThrowError();
    });

    test("fails when message order differs", () => {
        const messages = [
            new OrderPlaced({ orderId: "1", amount: 100 }),
            new PaymentReceived({ paymentId: "p1" }),
        ];
        const expected = [
            new PaymentReceived({ paymentId: "p1" }),
            new OrderPlaced({ orderId: "1", amount: 100 }),
        ];

        expect(() => expectMessagesToBeFullyEqual(messages, expected)).toThrowError();
    });
});

describe("expectMessagesToContain", () => {
    test("passes when all expected messages are found", () => {
        const messages = [
            new OrderPlaced({ orderId: "1", amount: 100 }),
            new PaymentReceived({ paymentId: "p1" }),
            new OrderPlaced({ orderId: "2", amount: 200 }),
        ];
        const expected = [
            new OrderPlaced({ orderId: "1", amount: 100 }),
            new PaymentReceived({ paymentId: "p1" }),
        ];

        expectMessagesToContain(messages, expected);
    });

    test("passes with empty expected array", () => {
        const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];

        expectMessagesToContain(messages, []);
    });

    test("fails when expected message is missing", () => {
        const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];
        const expected = [new PaymentReceived({ paymentId: "p1" })];

        expect(() => expectMessagesToContain(messages, expected)).toThrowError();
    });
});

describe("expectMessageToMatch", () => {
    describe("basic matching", () => {
        test("fails with empty message array", () => {
            expect(() => expectMessageToMatch([], Message, {})).toThrowError();
        });

        test("passes with empty payload expectation", () => {
            const messages = [new Message({})];

            expectMessageToMatch(messages, Message, {});
        });

        test("passes with exact payload match", () => {
            const messages = [new Message({ payload: "dummy" })];

            expectMessageToMatch(messages, Message, { payload: "dummy" });
        });
    });

    describe("type matching", () => {
        test("fails when message type not found", () => {
            const messages = [new Message({ payload: "dummy" })];

            expect(() =>
                expectMessageToMatch(messages, "NonExistentType", { payload: "dummy" })
            ).toThrowError();
        });

        test("supports MessageClass as type parameter", () => {
            const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];

            expectMessageToMatch(messages, OrderPlaced, { orderId: "1" });
        });

        test("supports string as type parameter", () => {
            const messages = [new OrderPlaced({ orderId: "1", amount: 100 })];

            expectMessageToMatch(messages, "OrderPlaced", { orderId: "1" });
        });
    });

    describe("partial matching", () => {
        test("passes with partial payload", () => {
            const messages = [
                new Message({
                    key1: "value1",
                    key2: "value2",
                }),
            ];

            expectMessageToMatch(messages, Message, { key1: "value1" });
        });

        test("passes with nested partial payload", () => {
            const messages = [
                new Message({
                    key: {
                        key1: "value1",
                        key2: "value2",
                    },
                }),
            ];

            expectMessageToMatch(messages, Message, { key: { key2: "value2" } });
        });

        test("fails when nested value differs", () => {
            const messages = [
                new Message({
                    key: {
                        key1: "value1",
                        key2: "value2",
                    },
                }),
            ];

            expect(() =>
                expectMessageToMatch(messages, Message, { key: { key2: "value3" } })
            ).toThrowError();
        });
    });

    describe("array matching", () => {
        test("passes with partial array match", () => {
            const messages = [
                new Message({
                    key: ["value1", "value2"],
                }),
            ];

            expectMessageToMatch(messages, Message, { key: ["value1"] });
        });

        test("passes with nested objects in array", () => {
            const messages = [
                new Message({
                    key: [
                        { key1: "value1", key2: "value2" },
                        { key1: "value3", key2: "value4" },
                    ],
                }),
            ];

            expectMessageToMatch(messages, Message, {
                key: [{ key1: "value1" }, { key2: "value4" }],
            });
        });
    });

    describe("error messages", () => {
        test("shows available message types when type not found", () => {
            const messages = [
                new OrderPlaced({ orderId: "1", amount: 100 }),
                new PaymentReceived({ paymentId: "p1" }),
            ];

            expect(() =>
                expectMessageToMatch(messages, "NonExistentType", {})
            ).toThrowError(/Available message types/);
        });

        test("shows closest match info when payload differs", () => {
            const messages = [
                new OrderPlaced({ orderId: "1", amount: 100 }),
                new OrderPlaced({ orderId: "2", amount: 200 }),
            ];

            expect(() =>
                expectMessageToMatch(messages, OrderPlaced, { orderId: "1", amount: 999 })
            ).toThrowError(/closest match/i);
        });

        test("finds closest match among multiple candidates", () => {
            const messages = [
                new OrderPlaced({ orderId: "wrong", amount: 999 }),
                new OrderPlaced({ orderId: "1", amount: 999 }),
            ];

            expect(() =>
                expectMessageToMatch(messages, OrderPlaced, { orderId: "1", amount: 100 })
            ).toThrowError(/1\/2 keys matched/);
        });
    });
});
