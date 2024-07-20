import { describe, expect, test } from "vitest";

import { isApplicationContextAware } from "./inspections";

describe("isApplicationContextAware", () => {
    test("when not", () => {
        expect(isApplicationContextAware({})).toBe(false);
        expect(isApplicationContextAware(null)).toBe(false);
        expect(isApplicationContextAware(undefined)).toBe(false);
        expect(isApplicationContextAware("")).toBe(false);
        expect(isApplicationContextAware(1)).toBe(false);
        expect(isApplicationContextAware(true)).toBe(false);
        expect(isApplicationContextAware([])).toBe(false);
        expect(isApplicationContextAware(() => {})).toBe(false);
    });

    test("when is", () => {
        expect(isApplicationContextAware({ setApplicationContext() {} })).toBe(
            true
        );
    });
});
