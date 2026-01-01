import * as ts from "typescript";

import type { ClassImport } from "./domain";

export function isExternalModule(moduleSpecifier: string): boolean {
    return !moduleSpecifier.startsWith(".");
}

export function extractImports(sourceFile: ts.SourceFile): ClassImport[] {
    const imports: ClassImport[] = [];

    ts.forEachChild(sourceFile, (node) => {
        if (ts.isImportDeclaration(node) && node.importClause) {
            const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
            const isExternal = isExternalModule(moduleSpecifier);
            const isTypeOnly = node.importClause.isTypeOnly ?? false;
            const importedNames = extractImportedNames(node.importClause);

            if (importedNames.length > 0) {
                imports.push({
                    names: importedNames,
                    source: moduleSpecifier,
                    isTypeOnly,
                    isExternal,
                });
            }
        }
    });

    return imports;
}

export function extractImportedNames(importClause: ts.ImportClause): string[] {
    const names: string[] = [];

    if (importClause.name) {
        names.push(importClause.name.text);
    }

    if (importClause.namedBindings) {
        if (ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
                names.push(element.name.text);
            }
        }
    }

    return names;
}
