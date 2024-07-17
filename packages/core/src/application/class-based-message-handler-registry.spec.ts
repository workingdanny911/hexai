import { beforeEach, describe, expect, test, vi } from "vitest";

import { Message } from "@/message";
import { MessageHandler } from "./message-handler";
import { ClassBasedMessageHandlerRegistry } from "./class-based-message-handler-registry";

class FooCommand extends Message<{ value: "foo" }> {
    public static create() {
        return new this({ value: "foo" });
    }
}

describe("ClassBasedMessageHandlerRegistry", () => {
    let registry: ClassBasedMessageHandlerRegistry;
    const messageHandler: MessageHandler<Message, any> = {
        handle: vi.fn(),
    };

    beforeEach(() => {
        registry = new ClassBasedMessageHandlerRegistry();

        vi.resetAllMocks();
    });

    const notClasses = [undefined, null, "", 0, false, NaN, {}];
    test.each(notClasses)("only accepts classes", (notAClass) => {
        // @ts-expect-error
        expect(() => registry.register(notAClass, messageHandler)).toThrowError(
            "not a class"
        );
    });

    test("when user tries to registering twice, throws error", () => {
        const registry = new ClassBasedMessageHandlerRegistry();

        registry.register(FooCommand, messageHandler);

        expect(() =>
            registry.register(FooCommand, messageHandler)
        ).toThrowError("already registered");
    });

    test("when user tries to get unregistered handler, throws error", () => {
        expect(registry.getByMessage(FooCommand.create())).toBeNull();
    });

    test("getting handler by message", () => {
        registry.register(FooCommand, messageHandler);

        expect(registry.getByMessage(FooCommand.create())).toBe(messageHandler);
    });
});
