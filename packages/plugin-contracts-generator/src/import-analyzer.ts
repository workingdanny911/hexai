import * as ts from "typescript";

import type { ClassImport } from "./domain/index.js";

export type ImportBindingKind = "named" | "default" | "namespace";

export interface ImportBinding {
    readonly importedName: string;
    readonly localName: string;
    readonly moduleSpecifier: string;
    readonly importKind: ImportBindingKind;
    readonly isTypeOnly: boolean;
    readonly declaration: ts.ImportDeclaration;
    readonly specifier?:
        | ts.ImportClause
        | ts.ImportSpecifier
        | ts.NamespaceImport;
}

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

export function extractImportBindings(sourceFile: ts.SourceFile): ImportBinding[] {
    const bindings: ImportBinding[] = [];

    ts.forEachChild(sourceFile, (node) => {
        if (!ts.isImportDeclaration(node) || !node.importClause) return;

        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        const importClause = node.importClause;
        const importClauseIsTypeOnly = importClause.isTypeOnly ?? false;

        if (importClause.name) {
            bindings.push({
                importedName: "default",
                localName: importClause.name.text,
                moduleSpecifier,
                importKind: "default",
                isTypeOnly: importClauseIsTypeOnly,
                declaration: node,
                specifier: importClause,
            });
        }

        if (!importClause.namedBindings) return;

        if (ts.isNamespaceImport(importClause.namedBindings)) {
            bindings.push({
                importedName: "*",
                localName: importClause.namedBindings.name.text,
                moduleSpecifier,
                importKind: "namespace",
                isTypeOnly: importClauseIsTypeOnly,
                declaration: node,
                specifier: importClause.namedBindings,
            });
            return;
        }

        for (const element of importClause.namedBindings.elements) {
            bindings.push({
                importedName: element.propertyName?.text ?? element.name.text,
                localName: element.name.text,
                moduleSpecifier,
                importKind: "named",
                isTypeOnly: importClauseIsTypeOnly || (element.isTypeOnly ?? false),
                declaration: node,
                specifier: element,
            });
        }
    });

    return bindings;
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
