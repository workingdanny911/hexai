import { beforeEach, describe, expect, test } from "vitest";

import { DummyMessage } from "@/test";

import { MessageRegistry } from "./message-registry";
import { Message, MessageClass, MessageHeaders } from "./message";
import { isMessageClass } from "./inspections";

describe("message registry", () => {
    let messageRegistry: MessageRegistry;
    let counter = 0;

    beforeEach(() => {
        messageRegistry = new MessageRegistry();
        counter = 0;
    });

    function headers(
        fields: { type: string } & Partial<MessageHeaders>
    ): MessageHeaders {
        return {
            id: fields.id ?? `message-id-${++counter}`,
            type: fields.type,
            schemaVersion: fields.schemaVersion,
            createdAt: fields.createdAt ?? new Date(),
        };
    }

    function register(cls: MessageClass): void {
        messageRegistry.register(cls);
    }

    function dehydrate(
        headers: MessageHeaders,
        body: Record<string, unknown> = {}
    ): Message {
        return messageRegistry.dehydrate(headers, body);
    }

    function expectMessageClass(cls: MessageClass, message: Message): void {
        expect(isMessageClass(cls)).toBe(true);
        expect(message.constructor).toBe(cls);
    }

    test("with single message type", () => {
        const E = createMessageClassForTest("event-type");

        register(E);

        expectMessageClass(E, dehydrate(headers({ type: "event-type" })));
    });

    test("with 2 message types", () => {
        const A = createMessageClassForTest("event-a");
        const B = createMessageClassForTest("event-b");

        register(A);
        register(B);

        expectMessageClass(A, dehydrate(headers({ type: "event-a" })));
        expectMessageClass(B, dehydrate(headers({ type: "event-b" })));
    });

    test("preserves header fields", () => {
        const event = DummyMessage.create();
        const { headers } = event.serialize();

        register(DummyMessage);

        const result: DummyMessage = dehydrate(headers) as any;

        expect(event.serialize().headers).toEqual(result.serialize().headers);
    });

    test("registering same message type twice - not versioned", () => {
        const E = createMessageClassForTest("same-type");
        const E2 = createMessageClassForTest("same-type");

        register(E);

        expect(() => register(E2)).toThrowError(
            /.*'.*same-type'.*already registered.*/
        );
    });

    test("registering same message type twice - versioned", () => {
        const E = createMessageClassForTest("same-type", 1);
        const E2 = createMessageClassForTest("same-type", 1);

        register(E);

        expect(() => register(E2)).toThrowError(
            /.*'.*same-type' with version '1'.*already registered.*/
        );
    });

    test("registering same message type with different versions", () => {
        const E1 = createMessageClassForTest("same-type");
        const E2 = createMessageClassForTest("same-type", 2);
        const E3_1 = createMessageClassForTest("same-type", "3.1");

        register(E1);
        register(E2);
        register(E3_1);

        expectMessageClass(E1, dehydrate(headers({ type: "same-type" })));
        expectMessageClass(
            E2,
            dehydrate(headers({ type: "same-type", schemaVersion: 2 }))
        );
        expectMessageClass(
            E3_1,
            dehydrate(headers({ type: "same-type", schemaVersion: "3.1" }))
        );
    });

    test("when trying to dehydrate to message type that is not registered", () => {
        expect(() =>
            dehydrate(headers({ type: "not-registered-event-type" }))
        ).toThrowError(/.*'not-registered-event-type'.*not registered.*/);
    });

    test("dehydration with data", () => {
        register(MessageWithData);

        const dehydrated = dehydrate(headers({ type: "message-with-data" }), {
            n: 1,
            s: "string",
            o: { object: null },
        });

        expect(dehydrated.constructor).toBe(MessageWithData);
        expect(dehydrated.getPayload()).toEqual({
            n: 1,
            s: "string",
            o: { object: null },
        });
    });
});

function createMessageClassForTest(
    type: string,
    version?: string | number
): MessageClass {
    return class MessageForTest extends DummyMessage {
        static type = type;
        static schemaVersion = version;

        public static deserializeRawPayload(
            rawPayload: Record<never, never>
        ): Record<never, never> {
            return {};
        }
    };
}

class MessageWithData extends Message<{
    n: number;
    s: string;
    o: { object: any };
}> {
    static type = "message-with-data";

    public static deserializeRawPayload(rawPayload: {
        n: number;
        s: string;
        o: { object: any };
    }): Record<string, unknown> {
        return rawPayload;
    }

    public serializePayload() {
        return this.payload;
    }
}
