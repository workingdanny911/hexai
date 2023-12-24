import { beforeEach, describe, expect, test } from "vitest";

import { Message, MessageClass, MessageHeader } from "Hexai/message";
import { DummyEvent } from "Hexai/test";

import { MessageRegistry } from "./message-registry";
import { isMessageClass } from "Hexai/helpers/index";

describe("message registry", () => {
    let messageRegistry: MessageRegistry;
    let counter = 0;

    beforeEach(() => {
        messageRegistry = new MessageRegistry();
        counter = 0;
    });

    function header(
        fields: { type: string } & Partial<MessageHeader>
    ): MessageHeader {
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
        header: MessageHeader,
        body: Record<string, unknown> = {}
    ): Message {
        return messageRegistry.dehydrate(header, body);
    }

    function expectMessageClass(cls: MessageClass, message: Message): void {
        expect(isMessageClass(cls)).toBe(true);
        expect(message.constructor).toBe(cls);
    }

    test("with single message type", () => {
        const E = createMessageClassForTest("event-type");

        register(E);

        expectMessageClass(E, dehydrate(header({ type: "event-type" })));
    });

    test("with 2 message types", () => {
        const A = createMessageClassForTest("event-a");
        const B = createMessageClassForTest("event-b");

        register(A);
        register(B);

        expectMessageClass(A, dehydrate(header({ type: "event-a" })));
        expectMessageClass(B, dehydrate(header({ type: "event-b" })));
    });

    test("preserves header fields", () => {
        const event = DummyEvent.create();
        const { header } = event.serialize();

        register(DummyEvent);

        const result: DummyEvent = dehydrate(header) as any;

        expect(event.serialize().header).toEqual(result.serialize().header);
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

        expectMessageClass(E1, dehydrate(header({ type: "same-type" })));
        expectMessageClass(
            E2,
            dehydrate(header({ type: "same-type", schemaVersion: 2 }))
        );
        expectMessageClass(
            E3_1,
            dehydrate(header({ type: "same-type", schemaVersion: "3.1" }))
        );
    });

    test("when trying to dehydrate to message type that is not registered", () => {
        expect(() =>
            dehydrate(header({ type: "not-registered-event-type" }))
        ).toThrowError(/.*'not-registered-event-type'.*not registered.*/);
    });

    test("dehydration with data", () => {
        register(MessageWithData);

        const dehydrated = dehydrate(header({ type: "message-with-data" }), {
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
    return class MessageForTest extends DummyEvent {
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
