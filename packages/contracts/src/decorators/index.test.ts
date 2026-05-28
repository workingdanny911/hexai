import { describe, expect, it } from "vitest";

import {
    PublicCommand,
    PublicContract,
    PublicEvent,
    PublicQuery,
} from "./index.js";

describe("public contract decorators", () => {
    it("should expose PublicContract as a no-op class decorator", () => {
        class PublicProjection {}

        const decorator = PublicContract();
        const result = decorator(PublicProjection);

        expect(result).toBe(PublicProjection);
    });

    it("should keep existing public message decorators as no-op class decorators", () => {
        class PublicMessage {}

        expect(PublicEvent()(PublicMessage)).toBe(PublicMessage);
        expect(PublicCommand()(PublicMessage)).toBe(PublicMessage);
        expect(PublicQuery()(PublicMessage)).toBe(PublicMessage);
    });
});
