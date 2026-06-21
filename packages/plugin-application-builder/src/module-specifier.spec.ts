import { describe, expect, it } from "vitest";

import {
    formatRelativeModuleSpecifier,
    formatRelativePathFromFile,
    formatRelativeTypeScriptFileSpecifier,
    getTypeScriptSourceFileCandidates,
    normalizeSourceImportToTypeScriptPath,
} from "./module-specifier.js";

describe("module specifier formatting", () => {
    it("formats TypeScript file paths as NodeNext-safe JavaScript specifiers", () => {
        expect(formatRelativeTypeScriptFileSpecifier("handler.ts", "js")).toBe(
            "./handler.js"
        );
        expect(
            formatRelativeTypeScriptFileSpecifier("../commands/request.ts", "js")
        ).toBe("../commands/request.js");
        expect(
            formatRelativeTypeScriptFileSpecifier("views/page.tsx", "js")
        ).toBe("./views/page.js");
    });

    it("preserves extensionless specifiers when requested", () => {
        expect(
            formatRelativeTypeScriptFileSpecifier(
                "../commands/request.ts",
                "extensionless"
            )
        ).toBe("../commands/request");
    });

    it("formats relative paths from the generated file to source files", () => {
        expect(
            formatRelativePathFromFile(
                "/context/src/.generated/application-builder.ts",
                "/context/src/handlers/create-user.handler.ts",
                "js"
            )
        ).toBe("../handlers/create-user.handler.js");
    });

    it("applies output policy to relative module specifiers without duplicating extensions", () => {
        expect(formatRelativeModuleSpecifier("../application.ts", "js")).toBe(
            "../application.js"
        );
        expect(formatRelativeModuleSpecifier("../application.js", "js")).toBe(
            "../application.js"
        );
        expect(
            formatRelativeModuleSpecifier("../application.js", "extensionless")
        ).toBe("../application");
    });

    it("normalizes runtime source imports to TypeScript source paths", () => {
        expect(normalizeSourceImportToTypeScriptPath("./command.js")).toBe(
            "./command.ts"
        );
        expect(normalizeSourceImportToTypeScriptPath("./command.ts")).toBe(
            "./command.ts"
        );
        expect(normalizeSourceImportToTypeScriptPath("./command.tsx")).toBe(
            "./command.tsx"
        );
        expect(normalizeSourceImportToTypeScriptPath("@/commands/request.js")).toBe(
            "@/commands/request.ts"
        );
    });

    it("returns TypeScript source candidates for runtime JavaScript imports", () => {
        expect(getTypeScriptSourceFileCandidates("./command.js")).toEqual([
            "./command.ts",
            "./command.tsx",
        ]);
        expect(getTypeScriptSourceFileCandidates("./command")).toEqual([
            "./command.ts",
            "./command.tsx",
            "./command/index.ts",
            "./command/index.tsx",
        ]);
    });
});
