import * as ts from "typescript";

import { UnsafeDependencySliceError } from "./errors.js";
import { extractImportBindings } from "./import-analyzer.js";

import type { FileSystem } from "./file-system.js";
import type { FileGraph, FileNode } from "./file-graph-resolver.js";
import type { ImportBinding, ImportBindingKind } from "./import-analyzer.js";

export interface RetainedImportedSymbol {
    readonly importedName: string;
    readonly localName: string;
    readonly importKind: ImportBindingKind;
    readonly isTypeOnly: boolean;
}

export interface RetainedLocalImport {
    readonly sourcePath: string;
    readonly moduleSpecifier: string;
    readonly resolvedPath: string;
    readonly importedSymbols: readonly RetainedImportedSymbol[];
}

export interface DependencySymbolSlicerOptions {
    readonly fileSystem: FileSystem;
}

export interface DependencySliceRequest {
    readonly fileGraph: FileGraph;
    readonly retainedLocalImports: readonly RetainedLocalImport[];
}

export interface DependencySliceResult {
    readonly contents: ReadonlyMap<string, string>;
}

interface TopLevelDeclaration {
    readonly names: readonly string[];
    readonly statement: ts.Statement;
}

interface ResolvedImportBinding extends ImportBinding {
    readonly resolvedPath?: string;
    readonly isExternal: boolean;
}

interface FilteredImport {
    readonly declaration: ts.ImportDeclaration;
    readonly retainedLocalImports: readonly RetainedLocalImport[];
}

interface SliceFileResult {
    readonly content: string;
    readonly retainedLocalImports: readonly RetainedLocalImport[];
}

export function findLocalImportTypeModuleSpecifier(
    sourceFile: ts.SourceFile
): string | undefined {
    let moduleSpecifier: string | undefined;

    const visit = (node: ts.Node): void => {
        if (moduleSpecifier) {
            return;
        }

        if (ts.isImportTypeNode(node)) {
            const importTypeModuleSpecifier =
                getImportTypeModuleSpecifier(node);
            if (importTypeModuleSpecifier?.startsWith(".")) {
                moduleSpecifier = importTypeModuleSpecifier;
                return;
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return moduleSpecifier;
}

function getImportTypeModuleSpecifier(
    node: ts.ImportTypeNode
): string | undefined {
    const argument = node.argument;

    if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteral(argument.literal)
    ) {
        return argument.literal.text;
    }

    return undefined;
}

export class DependencySymbolSlicer {
    private readonly fs: FileSystem;
    private readonly contents = new Map<string, string>();
    private readonly requiredSymbolsByFile = new Map<string, Set<string>>();
    private readonly pendingFiles: string[] = [];
    private readonly processedSignatures = new Map<string, string>();

    constructor(options: DependencySymbolSlicerOptions) {
        this.fs = options.fileSystem;
    }

    async slice(request: DependencySliceRequest): Promise<DependencySliceResult> {
        for (const retainedImport of request.retainedLocalImports) {
            this.enqueueRetainedImport(retainedImport);
        }

        while (this.pendingFiles.length > 0) {
            const filePath = this.pendingFiles.shift()!;
            await this.processFile(filePath, request.fileGraph);
        }

        return {
            contents: this.contents,
        };
    }

    private enqueueRetainedImport(retainedImport: RetainedLocalImport): void {
        const namedSymbols = retainedImport.importedSymbols.filter(
            (symbol) => symbol.importKind === "named"
        );

        if (namedSymbols.length !== retainedImport.importedSymbols.length) {
            const unsupportedSymbol = retainedImport.importedSymbols.find(
                (symbol) => symbol.importKind !== "named"
            );
            this.throwUnsafe(
                retainedImport.sourcePath,
                `unsupported import shape: ${unsupportedSymbol?.importKind ?? "unknown"} import`
            );
        }

        for (const symbol of namedSymbols) {
            this.enqueueSymbol(retainedImport.resolvedPath, symbol.importedName);
        }
    }

    private enqueueSymbol(filePath: string, symbolName: string): void {
        const requiredSymbols =
            this.requiredSymbolsByFile.get(filePath) ?? new Set<string>();
        const sizeBefore = requiredSymbols.size;
        requiredSymbols.add(symbolName);
        this.requiredSymbolsByFile.set(filePath, requiredSymbols);

        if (
            requiredSymbols.size !== sizeBefore &&
            !this.pendingFiles.includes(filePath)
        ) {
            this.pendingFiles.push(filePath);
        }
    }

    private async processFile(filePath: string, fileGraph: FileGraph): Promise<void> {
        const node = fileGraph.nodes.get(filePath);
        if (!node) {
            return;
        }

        const requiredSymbols =
            this.requiredSymbolsByFile.get(filePath) ?? new Set<string>();
        const signature = [...requiredSymbols].sort().join("|");
        if (this.processedSignatures.get(filePath) === signature) {
            return;
        }

        const content = await this.fs.readFile(filePath);
        const sourceFile = this.createSourceFile(filePath, content);

        const unsafeReason = this.findUnsafeReason(sourceFile);
        if (unsafeReason) {
            this.throwUnsafe(filePath, unsafeReason);
        }

        const sliceResult = this.sliceSourceFile(
            node,
            sourceFile,
            requiredSymbols
        );

        this.contents.set(filePath, sliceResult.content);
        this.processedSignatures.set(filePath, signature);

        for (const retainedImport of sliceResult.retainedLocalImports) {
            this.enqueueRetainedImport(retainedImport);
        }
    }

    private sliceSourceFile(
        node: FileNode,
        sourceFile: ts.SourceFile,
        requiredSymbols: ReadonlySet<string>
    ): SliceFileResult {
        const declarations = this.buildTopLevelDeclarationIndex(sourceFile);

        const importBindings = this.buildResolvedImportBindings(node, sourceFile);
        const includedStatements = new Set<ts.Statement>();
        const emittedSymbols = new Set<string>();
        const referencedIdentifiers = new Set<string>(requiredSymbols);
        const queue = [...requiredSymbols];

        while (queue.length > 0) {
            const symbolName = queue.shift()!;
            const declaration = declarations.get(symbolName);

            if (!declaration) {
                this.throwUnsafe(
                    sourceFile.fileName,
                    `missing required symbol: ${symbolName}`
                );
            }

            if (declaration.names.every((name) => emittedSymbols.has(name))) {
                continue;
            }

            includedStatements.add(declaration.statement);
            for (const name of declaration.names) {
                emittedSymbols.add(name);
            }

            for (const identifier of this.collectReferencedIdentifiers(
                declaration.statement
            )) {
                referencedIdentifiers.add(identifier);
                if (declarations.has(identifier) && !emittedSymbols.has(identifier)) {
                    queue.push(identifier);
                }
            }
        }

        const filteredImports: ts.ImportDeclaration[] = [];
        const retainedLocalImports: RetainedLocalImport[] = [];

        for (const statement of sourceFile.statements) {
            if (!ts.isImportDeclaration(statement) || !statement.importClause) {
                continue;
            }

            const filteredImport = this.filterImportDeclaration(
                statement,
                referencedIdentifiers,
                emittedSymbols,
                importBindings
            );

            if (!filteredImport) {
                continue;
            }

            filteredImports.push(filteredImport.declaration);
            retainedLocalImports.push(...filteredImport.retainedLocalImports);
        }

        return {
            content: this.printSlicedContent(
                sourceFile,
                filteredImports,
                includedStatements
            ),
            retainedLocalImports,
        };
    }

    private buildTopLevelDeclarationIndex(
        sourceFile: ts.SourceFile
    ): Map<string, TopLevelDeclaration> {
        const declarations = new Map<string, TopLevelDeclaration>();

        for (const statement of sourceFile.statements) {
            const names = this.getTopLevelDeclarationNames(statement);
            for (const name of names) {
                if (declarations.has(name)) {
                    this.throwUnsafe(
                        sourceFile.fileName,
                        `duplicate top-level declaration: ${name}`
                    );
                }
                declarations.set(name, { names, statement });
            }
        }

        return declarations;
    }

    private getTopLevelDeclarationNames(statement: ts.Statement): readonly string[] {
        if (
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isFunctionDeclaration(statement)
        ) {
            return statement.name ? [statement.name.text] : [];
        }

        if (ts.isVariableStatement(statement)) {
            return statement.declarationList.declarations
                .filter((declaration) => ts.isIdentifier(declaration.name))
                .map((declaration) => (declaration.name as ts.Identifier).text);
        }

        return [];
    }

    private buildResolvedImportBindings(
        node: FileNode,
        sourceFile: ts.SourceFile
    ): Map<string, ResolvedImportBinding> {
        const bindings = new Map<string, ResolvedImportBinding>();

        for (const binding of extractImportBindings(sourceFile)) {
            const importInfo = node.imports.find(
                (candidate) =>
                    candidate.moduleSpecifier === binding.moduleSpecifier
            );
            bindings.set(binding.localName, {
                ...binding,
                resolvedPath: importInfo?.resolvedPath ?? undefined,
                isExternal: importInfo?.isExternal ?? false,
            });
        }

        return bindings;
    }

    private filterImportDeclaration(
        declaration: ts.ImportDeclaration,
        referencedIdentifiers: ReadonlySet<string>,
        emittedSymbols: ReadonlySet<string>,
        importBindings: ReadonlyMap<string, ResolvedImportBinding>
    ): FilteredImport | undefined {
        const importClause = declaration.importClause;
        if (!importClause) {
            return undefined;
        }

        if (
            importClause.name &&
            referencedIdentifiers.has(importClause.name.text)
        ) {
            this.throwUnsafe(
                declaration.getSourceFile().fileName,
                "unsupported import shape: default import"
            );
        }

        const namedBindings = importClause.namedBindings;
        if (!namedBindings) {
            return undefined;
        }

        if (ts.isNamespaceImport(namedBindings)) {
            if (referencedIdentifiers.has(namedBindings.name.text)) {
                this.throwUnsafe(
                    declaration.getSourceFile().fileName,
                    "unsupported import shape: namespace import"
                );
            }

            return undefined;
        }

        const retainedElements = namedBindings.elements.filter((element) => {
            const localName = element.name.text;
            return (
                referencedIdentifiers.has(localName) &&
                !emittedSymbols.has(localName)
            );
        });

        if (retainedElements.length === 0) {
            return undefined;
        }

        const retainedLocalImports = this.createRetainedLocalImports(
            declaration.moduleSpecifier,
            retainedElements,
            importBindings
        );
        const retainedNamedBindings = ts.factory.updateNamedImports(
            namedBindings,
            retainedElements
        );
        const retainedImportClause = ts.factory.updateImportClause(
            importClause,
            importClause.isTypeOnly,
            undefined,
            retainedNamedBindings
        );

        return {
            declaration: ts.factory.updateImportDeclaration(
                declaration,
                declaration.modifiers,
                retainedImportClause,
                declaration.moduleSpecifier,
                declaration.attributes
            ),
            retainedLocalImports,
        };
    }

    private createRetainedLocalImports(
        moduleSpecifier: ts.Expression,
        retainedElements: readonly ts.ImportSpecifier[],
        importBindings: ReadonlyMap<string, ResolvedImportBinding>
    ): RetainedLocalImport[] {
        if (!ts.isStringLiteral(moduleSpecifier)) {
            return [];
        }

        const importedSymbols: RetainedImportedSymbol[] = [];
        let resolvedPath: string | undefined;

        for (const element of retainedElements) {
            const binding = importBindings.get(element.name.text);
            if (!binding || binding.isExternal || !binding.resolvedPath) {
                continue;
            }

            resolvedPath = binding.resolvedPath;
            importedSymbols.push({
                importedName: binding.importedName,
                localName: binding.localName,
                importKind: binding.importKind,
                isTypeOnly: binding.isTypeOnly,
            });
        }

        if (!resolvedPath || importedSymbols.length === 0) {
            return [];
        }

        return [
            {
                sourcePath: moduleSpecifier.getSourceFile().fileName,
                moduleSpecifier: moduleSpecifier.text,
                resolvedPath,
                importedSymbols,
            },
        ];
    }

    private printSlicedContent(
        sourceFile: ts.SourceFile,
        filteredImports: readonly ts.ImportDeclaration[],
        includedStatements: ReadonlySet<ts.Statement>
    ): string {
        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
        const output: string[] = [];

        for (const importDeclaration of filteredImports) {
            output.push(
                printer
                    .printNode(ts.EmitHint.Unspecified, importDeclaration, sourceFile)
                    .trim()
            );
        }

        if (filteredImports.length > 0) {
            output.push("");
        }

        for (const statement of sourceFile.statements) {
            if (!includedStatements.has(statement)) {
                continue;
            }

            output.push(
                printer
                    .printNode(ts.EmitHint.Unspecified, statement, sourceFile)
                    .trim()
            );
            output.push("");
        }

        return output.join("\n").trimEnd() + "\n";
    }

    private findUnsafeReason(sourceFile: ts.SourceFile): string | undefined {
        const localImportType = findLocalImportTypeModuleSpecifier(sourceFile);
        if (localImportType) {
            return `local import type: ${localImportType}`;
        }

        if (this.containsDynamicImport(sourceFile)) {
            return "dynamic import";
        }

        for (const statement of sourceFile.statements) {
            if (ts.isImportDeclaration(statement)) {
                if (!statement.importClause) {
                    return "side-effect import";
                }
                continue;
            }

            if (
                ts.isExportDeclaration(statement) ||
                ts.isExportAssignment(statement)
            ) {
                return "export declaration";
            }

            if (ts.isClassDeclaration(statement)) {
                const classUnsafeReason = this.findUnsafeClassReason(statement);
                if (classUnsafeReason) {
                    return classUnsafeReason;
                }
                continue;
            }

            if (ts.isEnumDeclaration(statement)) {
                if (statement.members.some((member) => member.initializer)) {
                    return "enum initializer";
                }
                continue;
            }

            if (
                ts.isInterfaceDeclaration(statement) ||
                ts.isTypeAliasDeclaration(statement) ||
                ts.isFunctionDeclaration(statement)
            ) {
                continue;
            }

            if (ts.isVariableStatement(statement)) {
                if (this.hasUnsafeVariableInitializer(statement)) {
                    return "unsafe top-level variable initializer";
                }
                continue;
            }

            if (ts.isEmptyStatement(statement)) {
                continue;
            }

            return "top-level statement";
        }

        return undefined;
    }

    private findUnsafeClassReason(
        statement: ts.ClassDeclaration
    ): string | undefined {
        if (this.hasDecorators(statement)) {
            return "class decorator";
        }

        const classHeritageReason = this.findUnsafeClassHeritageReason(statement);
        if (classHeritageReason) {
            return classHeritageReason;
        }

        for (const member of statement.members) {
            if (ts.isClassStaticBlockDeclaration(member)) {
                return "class static block";
            }

            if (this.hasDecorators(member)) {
                return "class member decorator";
            }

            if (this.hasComputedClassMemberName(member)) {
                return "class computed member name";
            }

            if (this.hasStaticMemberInitializer(member)) {
                return "class static member initializer";
            }

            if (
                ts.isConstructorDeclaration(member) &&
                member.parameters.some((parameter) => this.hasDecorators(parameter))
            ) {
                return "class member decorator";
            }
        }

        return undefined;
    }

    private findUnsafeClassHeritageReason(
        statement: ts.ClassDeclaration
    ): string | undefined {
        for (const clause of statement.heritageClauses ?? []) {
            if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
                continue;
            }

            for (const heritageType of clause.types) {
                if (
                    !ts.isIdentifier(heritageType.expression) ||
                    this.containsUnsafeSliceExpression(heritageType.expression)
                ) {
                    return "class heritage/extends";
                }
            }
        }

        return undefined;
    }

    private hasComputedClassMemberName(member: ts.ClassElement): boolean {
        const name = this.getClassElementName(member);
        return name !== undefined && ts.isComputedPropertyName(name);
    }

    private hasStaticMemberInitializer(member: ts.ClassElement): boolean {
        if (!this.hasStaticModifier(member)) {
            return false;
        }

        if (
            ts.isPropertyDeclaration(member) ||
            ts.isAutoAccessorPropertyDeclaration(member)
        ) {
            return member.initializer !== undefined;
        }

        return false;
    }

    private getClassElementName(
        member: ts.ClassElement
    ): ts.PropertyName | undefined {
        if (
            ts.isPropertyDeclaration(member) ||
            ts.isMethodDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member) ||
            ts.isAutoAccessorPropertyDeclaration(member)
        ) {
            return member.name;
        }

        return undefined;
    }

    private hasStaticModifier(node: ts.Node): boolean {
        return (
            ts.canHaveModifiers(node) &&
            (ts.getModifiers(node)?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword
            ) ??
                false)
        );
    }

    private hasDecorators(node: ts.Node): boolean {
        return (
            ts.canHaveDecorators(node) &&
            (ts.getDecorators(node)?.length ?? 0) > 0
        );
    }

    private hasUnsafeVariableInitializer(statement: ts.VariableStatement): boolean {
        return statement.declarationList.declarations.some((declaration) => {
            if (!declaration.initializer) {
                return false;
            }

            return this.containsUnsafeSliceExpression(declaration.initializer);
        });
    }

    private containsUnsafeSliceExpression(root: ts.Node): boolean {
        return this.containsNode(root, (node) =>
            this.isUnsafeSliceExpression(node)
        );
    }

    private isUnsafeSliceExpression(node: ts.Node): boolean {
        if (
            ts.isCallExpression(node) ||
            ts.isNewExpression(node) ||
            ts.isTaggedTemplateExpression(node) ||
            ts.isAwaitExpression(node) ||
            ts.isDeleteExpression(node) ||
            ts.isYieldExpression(node)
        ) {
            return true;
        }

        if (ts.isBinaryExpression(node)) {
            return this.isAssignmentOperator(node.operatorToken.kind);
        }

        if (
            ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)
        ) {
            return (
                node.operator === ts.SyntaxKind.PlusPlusToken ||
                node.operator === ts.SyntaxKind.MinusMinusToken
            );
        }

        return false;
    }

    private isAssignmentOperator(kind: ts.SyntaxKind): boolean {
        return (
            kind >= ts.SyntaxKind.FirstAssignment &&
            kind <= ts.SyntaxKind.LastAssignment
        );
    }

    private containsDynamicImport(sourceFile: ts.SourceFile): boolean {
        return this.containsNode(sourceFile, (node) => {
            if (!ts.isCallExpression(node)) {
                return false;
            }

            return node.expression.kind === ts.SyntaxKind.ImportKeyword;
        });
    }

    private containsNode(
        root: ts.Node,
        predicate: (node: ts.Node) => boolean
    ): boolean {
        let found = false;

        const visit = (node: ts.Node): void => {
            if (found) {
                return;
            }

            if (predicate(node)) {
                found = true;
                return;
            }

            ts.forEachChild(node, visit);
        };

        visit(root);
        return found;
    }

    private collectReferencedIdentifiers(node: ts.Node): Set<string> {
        const identifiers = new Set<string>();

        const visit = (current: ts.Node): void => {
            this.collectReferencedIdentifier(current, identifiers);
            ts.forEachChild(current, visit);
        };

        visit(node);
        return identifiers;
    }

    private collectReferencedIdentifier(
        node: ts.Node,
        identifiers: Set<string>
    ): void {
        if (ts.isTypeReferenceNode(node)) {
            this.collectEntityNameRootIdentifier(node.typeName, identifiers);
        }
        if (ts.isTypeQueryNode(node)) {
            this.collectEntityNameRootIdentifier(node.exprName, identifiers);
        }
        if (ts.isExpressionWithTypeArguments(node)) {
            this.collectExpressionRootIdentifier(node.expression, identifiers);
        }
        if (
            ts.isCallExpression(node) ||
            ts.isNewExpression(node) ||
            ts.isPropertyAccessExpression(node)
        ) {
            this.collectExpressionRootIdentifier(node.expression, identifiers);
        }
        if (ts.isIdentifier(node) && this.isRuntimeReferenceIdentifier(node)) {
            identifiers.add(node.text);
        }
    }

    private collectEntityNameRootIdentifier(
        entityName: ts.EntityName,
        identifiers: Set<string>
    ): void {
        let current: ts.EntityName = entityName;

        while (ts.isQualifiedName(current)) {
            current = current.left;
        }

        identifiers.add(current.text);
    }

    private collectExpressionRootIdentifier(
        expression: ts.Expression,
        identifiers: Set<string>
    ): void {
        let current: ts.Expression = expression;

        while (ts.isPropertyAccessExpression(current)) {
            current = current.expression;
        }

        if (ts.isIdentifier(current)) {
            identifiers.add(current.text);
        }
    }

    private isRuntimeReferenceIdentifier(node: ts.Identifier): boolean {
        if (!node.parent) {
            return false;
        }

        if (
            this.isDeclarationName(node) ||
            this.isPropertyName(node) ||
            this.isImportOrExportName(node) ||
            this.isTypeOnlyIdentifier(node)
        ) {
            return false;
        }

        return true;
    }

    private isDeclarationName(node: ts.Identifier): boolean {
        const parent = node.parent;

        return (
            ((ts.isClassDeclaration(parent) ||
                ts.isInterfaceDeclaration(parent) ||
                ts.isTypeAliasDeclaration(parent) ||
                ts.isEnumDeclaration(parent) ||
                ts.isFunctionDeclaration(parent) ||
                ts.isMethodDeclaration(parent) ||
                ts.isPropertyDeclaration(parent) ||
                ts.isParameter(parent)) &&
                parent.name === node) ||
            (ts.isVariableDeclaration(parent) && parent.name === node) ||
            (ts.isEnumMember(parent) && parent.name === node)
        );
    }

    private isPropertyName(node: ts.Identifier): boolean {
        const parent = node.parent;

        return (
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node) ||
            (ts.isMethodDeclaration(parent) && parent.name === node) ||
            (ts.isPropertyDeclaration(parent) && parent.name === node)
        );
    }

    private isImportOrExportName(node: ts.Identifier): boolean {
        const parent = node.parent;

        return (
            ts.isImportSpecifier(parent) ||
            ts.isExportSpecifier(parent) ||
            ts.isImportClause(parent) ||
            ts.isNamespaceImport(parent)
        );
    }

    private isTypeOnlyIdentifier(node: ts.Identifier): boolean {
        let current: ts.Node | undefined = node.parent;

        while (current) {
            if (ts.isTypeNode(current)) {
                return true;
            }

            if (
                ts.isExpression(current) ||
                ts.isStatement(current) ||
                ts.isClassElement(current) ||
                ts.isSourceFile(current)
            ) {
                return false;
            }

            current = current.parent;
        }

        return false;
    }

    private throwUnsafe(filePath: string, reason: string): never {
        throw new UnsafeDependencySliceError(filePath, reason);
    }

    private createSourceFile(filePath: string, content: string): ts.SourceFile {
        return ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );
    }
}
