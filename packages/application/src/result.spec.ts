import { describe, expect, test } from "vitest";

import { ErrorResult, SuccessResult } from "@/application";

describe("SuccessResult", () => {
    test("getOrThrow returns the data", () => {
        const result = new SuccessResult({ value: 42 });

        expect(result.getOrThrow()).toEqual({ value: 42 });
    });

    test("getOrThrow infers the correct type", () => {
        const result = new SuccessResult({ name: "test", count: 5 });

        const data = result.getOrThrow();

        expect(data.name).toBe("test");
        expect(data.count).toBe(5);
    });
});

describe("ErrorResult", () => {
    test("getOrThrow throws the error", () => {
        const error = new Error("something went wrong");
        const result = new ErrorResult(error);

        expect(() => result.getOrThrow()).toThrow(error);
    });
});
