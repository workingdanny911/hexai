import { describe, expect, it } from "vitest";

import {
    formatRelativeIndexSpecifier,
    formatRelativePathFromFile,
    formatRelativeTypeScriptFileSpecifier,
} from "./module-specifier.js";

describe("module specifier formatting", () => {
    it("formats TypeScript file paths as NodeNext-safe JavaScript specifiers", () => {
        expect(formatRelativeTypeScriptFileSpecifier("events.ts", "js")).toBe(
            "./events.js"
        );
        expect(
            formatRelativeTypeScriptFileSpecifier("nested/is-empty.ts", "js")
        ).toBe("./nested/is-empty.js");
        expect(
            formatRelativeTypeScriptFileSpecifier("../shared/types.ts", "js")
        ).toBe("../shared/types.js");
    });

    it("preserves extensionless TypeScript file specifiers when requested", () => {
        expect(
            formatRelativeTypeScriptFileSpecifier("nested/is-empty.ts", "extensionless")
        ).toBe("./nested/is-empty");
    });

    it("formats relative paths between copied files", () => {
        expect(
            formatRelativePathFromFile(
                "commands/create.ts",
                "types/shared.ts",
                "js"
            )
        ).toBe("../types/shared.js");
    });

    it("formats context index imports", () => {
        expect(formatRelativeIndexSpecifier("./lecture-profile", "js")).toBe(
            "./lecture-profile/index.js"
        );
        expect(
            formatRelativeIndexSpecifier("./lecture-profile", "extensionless")
        ).toBe("./lecture-profile");
    });
});
