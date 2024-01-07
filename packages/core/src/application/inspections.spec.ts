import { describe, expect, test } from "vitest";

import {
    isApplicationContextAware,
    isEventPublisherAware,
} from "./inspections";

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

describe("isEventPublisherAware", () => {
    test("when not", () => {
        expect(isEventPublisherAware({})).toBe(false);
        expect(isEventPublisherAware(null)).toBe(false);
        expect(isEventPublisherAware(undefined)).toBe(false);
        expect(isEventPublisherAware("")).toBe(false);
        expect(isEventPublisherAware(1)).toBe(false);
        expect(isEventPublisherAware(true)).toBe(false);
        expect(isEventPublisherAware([])).toBe(false);
        expect(isEventPublisherAware(() => {})).toBe(false);
    });

    test("when is", () => {
        expect(
            isEventPublisherAware({
                setEventPublisher() {},
            })
        ).toBe(true);
    });
});
