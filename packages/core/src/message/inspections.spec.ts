import { describe, expect, test } from "vitest";

import { isMessageClass } from "./inspections";
import { Message } from "@/message/message";

describe("isMessageClass", () => {
    test("when not", () => {
        expect(isMessageClass({})).toBe(false);
        expect(isMessageClass(null)).toBe(false);
        expect(isMessageClass(undefined)).toBe(false);
        expect(isMessageClass("")).toBe(false);
        expect(isMessageClass(1)).toBe(false);
        expect(isMessageClass(true)).toBe(false);
        expect(isMessageClass([])).toBe(false);
        expect(isMessageClass(() => {})).toBe(false);
    });

    test("when is", () => {
        expect(isMessageClass(class FooMessage extends Message {})).toBe(true);
    });
});
