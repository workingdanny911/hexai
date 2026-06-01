import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import {
    extractImportBindings,
    extractImportedNames,
    extractImports,
} from "./import-analyzer.js";

function createSourceFile(sourceCode: string): ts.SourceFile {
    return ts.createSourceFile(
        "contracts.ts",
        sourceCode,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
}

describe("import analyzer", () => {
    it("should keep existing import extraction behavior unchanged", () => {
        const sourceFile = createSourceFile(`
            import DefaultContract, { ContractCommand as InternalCommand } from "@hexaijs/contracts";
            import type { ContractEvent } from "@hexaijs/contracts/decorators";
        `);

        const imports = extractImports(sourceFile);

        expect(imports).toEqual([
            {
                names: ["DefaultContract", "InternalCommand"],
                source: "@hexaijs/contracts",
                isTypeOnly: false,
                isExternal: true,
            },
            {
                names: ["ContractEvent"],
                source: "@hexaijs/contracts/decorators",
                isTypeOnly: true,
                isExternal: true,
            },
        ]);
    });

    it("should extract import bindings with imported and local names", () => {
        const sourceFile = createSourceFile(`
            import DefaultContract, { ContractCommand as InternalCommand, type ContractQuery } from "@hexaijs/contracts";
            import * as ContractDecorators from "@hexaijs/contracts/decorators";
        `);

        const bindings = extractImportBindings(sourceFile).map((binding) => ({
            importedName: binding.importedName,
            localName: binding.localName,
            moduleSpecifier: binding.moduleSpecifier,
            importKind: binding.importKind,
            isTypeOnly: binding.isTypeOnly,
            hasDeclaration: ts.isImportDeclaration(binding.declaration),
            hasSpecifier: binding.specifier !== undefined,
        }));

        expect(bindings).toEqual([
            {
                importedName: "default",
                localName: "DefaultContract",
                moduleSpecifier: "@hexaijs/contracts",
                importKind: "default",
                isTypeOnly: false,
                hasDeclaration: true,
                hasSpecifier: true,
            },
            {
                importedName: "ContractCommand",
                localName: "InternalCommand",
                moduleSpecifier: "@hexaijs/contracts",
                importKind: "named",
                isTypeOnly: false,
                hasDeclaration: true,
                hasSpecifier: true,
            },
            {
                importedName: "ContractQuery",
                localName: "ContractQuery",
                moduleSpecifier: "@hexaijs/contracts",
                importKind: "named",
                isTypeOnly: true,
                hasDeclaration: true,
                hasSpecifier: true,
            },
            {
                importedName: "*",
                localName: "ContractDecorators",
                moduleSpecifier: "@hexaijs/contracts/decorators",
                importKind: "namespace",
                isTypeOnly: false,
                hasDeclaration: true,
                hasSpecifier: true,
            },
        ]);
    });

    it("should expose local imported names from import clauses", () => {
        const sourceFile = createSourceFile(`
            import { ContractCommand as InternalCommand } from "@hexaijs/contracts";
        `);
        const importDeclaration = sourceFile.statements[0];

        if (!ts.isImportDeclaration(importDeclaration) || !importDeclaration.importClause) {
            throw new Error("Expected import declaration");
        }

        expect(extractImportedNames(importDeclaration.importClause)).toEqual([
            "InternalCommand",
        ]);
    });
});
