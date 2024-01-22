import { beforeEach, describe, expect, test, vi } from "vitest";

import { Message } from "@/message";
import { CommandExecutor } from "./command-executor";
import { ClassBasedCommandExecutorRegistry } from "./class-based-command-executor-registry";

class FooCommand extends Message<{ value: "foo" }> {
    public static create() {
        return new this({ value: "foo" });
    }
}

describe("ClassBasedMessageHandlerRegistry", () => {
    let registry: ClassBasedCommandExecutorRegistry;
    const executor: CommandExecutor<Message, any> = {
        execute: vi.fn(),
    };

    beforeEach(() => {
        registry = new ClassBasedCommandExecutorRegistry();

        vi.resetAllMocks();
    });

    const notClasses = [undefined, null, "", 0, false, NaN, {}];
    test.each(notClasses)("only accepts classes", (notAClass) => {
        // @ts-expect-error
        expect(() => registry.register(notAClass, executor)).toThrowError(
            "not a class"
        );
    });

    test("when registering twice", () => {
        const registry = new ClassBasedCommandExecutorRegistry();

        registry.register(FooCommand, executor);

        expect(() => registry.register(FooCommand, executor)).toThrowError(
            "already registered"
        );
    });

    test("when handler is not registered", () => {
        expect(registry.get(FooCommand.create())).toBeNull();
    });

    test("get", () => {
        registry.register(FooCommand, executor);

        expect(registry.get(FooCommand.create())).toBe(executor);
    });
});
