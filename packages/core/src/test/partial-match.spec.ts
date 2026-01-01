import { describe, expect, test } from "vitest";
import { partialMatch } from "./partial-match";

describe("partialMatch", () => {
    test("empty", () => {
        expect(partialMatch({}, {})).toBe(true);

        expect(partialMatch({}, { a: 1 })).toBe(false);

        expect(partialMatch({ a: 1 }, {})).toBe(true);
    });

    test("exact match", () => {
        expect(partialMatch({ a: 1 }, { a: 1 })).toBe(true);
    });

    test("partial match", () => {
        expect(partialMatch({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    });

    test("no match", () => {
        expect(partialMatch({ a: 1 }, { a: 2 })).toBe(false);
    });

    test("exact match - object", () => {
        expect(partialMatch({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    });

    test("partial match - object", () => {
        expect(partialMatch({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toBe(true);
    });

    test("object in array", () => {
        expect(partialMatch([{ a: 1 }], [{ a: 1 }])).toBe(true);
    });

    test("partial object in array", () => {
        expect(partialMatch([{ a: 1, b: 2 }], [{ a: 1 }])).toBe(true);
    });

    test("partial object in array - no match", () => {
        expect(partialMatch([{ a: 1, b: 2 }], [{ a: 2 }])).toBe(false);
    });
});
