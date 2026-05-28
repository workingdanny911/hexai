import * as path from "path";
import * as ts from "typescript";

import type { FileGraph, FileNode } from "./file-graph-resolver.js";
import { FileReadError, FileWriteError } from "./errors.js";
import { FileSystem, nodeFileSystem } from "./file-system.js";
import type {
    ContractMarkerNames,
    DecoratorNames,
    EntryStrategy,
    MessageType,
} from "./domain/index.js";
import {
    DEFAULT_CONTRACT_MARKER_NAMES,
    DEFAULT_DECORATOR_NAMES,
} from "./domain/index.js";
import { hasDecorator, hasLeadingCommentMarker } from "./class-analyzer.js";

const CONTRACTS_GENERATOR_MODULE = "@hexaijs/plugin-contracts-generator";
const CONTRACTS_ROOT_MODULE = "@hexaijs/contracts";
const CONTRACTS_DECORATORS_MODULE = "@hexaijs/contracts/decorators";
const TS_EXTENSION_PATTERN = /\.ts$/;
const TS_EXTENSION = ".ts";
const REQUEST_SUFFIX = "Request";
const QUERY_SUFFIX = "Query";

export interface CopyOptions {
    sourceRoot: string;
    outputDir: string;
    fileGraph: FileGraph;
    pathAliasRewrites?: Map<string, string>;
    removeDecorators?: boolean;
    responseTypesToExport?: Map<string, string[]>;
    responseTypesToInclude?: Map<string, string[]>;
    publicContractsToExport?: Map<string, string[]>;
    messageTypes?: readonly MessageType[];
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    includePublicContracts?: boolean;
    entryStrategy?: EntryStrategy;
}

export interface CopyResult {
    copiedFiles: string[];
    rewrittenImports: Map<string, string[]>;
}

export interface FileCopierOptions {
    fileSystem?: FileSystem;
}

interface TransformResult<T extends string> {
    content: string;
    changes: T[];
}

type VisitorFunction = (node: ts.Node) => ts.Node | undefined;

interface SymbolExtractionContext {
    sourceFile: ts.SourceFile;
    content: string;
    messageTypes: readonly MessageType[];
    decoratorToMessageType: Record<string, MessageType>;
    contractMarkerName: string;
    includePublicContracts: boolean;
}

interface ExtractedSymbols {
    targetClassNames: Set<string>;
    targetDeclarations: ts.Node[];
    usedIdentifiers: Set<string>;
    includedLocalTypes: Set<string>;
    localTypeDeclarations: Map<string, ts.Node[]>;
}

interface ImportInfo {
    moduleSpecifier: string;
    declaration: ts.ImportDeclaration;
    localNames: Set<string>;
}

export class FileCopier {
    private readonly fs: FileSystem;

    constructor(options: FileCopierOptions = {}) {
        this.fs = options.fileSystem ?? nodeFileSystem;
    }

    async copyFiles(options: CopyOptions): Promise<CopyResult> {
        const {
            sourceRoot,
            outputDir,
            fileGraph,
            pathAliasRewrites,
            removeDecorators,
            responseTypesToExport,
            responseTypesToInclude,
            publicContractsToExport,
            messageTypes,
            decoratorNames,
            contractMarkerNames,
            includePublicContracts,
            entryStrategy = "graph",
        } = options;
        const copiedFiles: string[] = [];
        const rewrittenImports = new Map<string, string[]>();

        const { entryContents, usedLocalImports } =
            await this.preprocessEntryFiles(
                fileGraph,
                entryStrategy,
                messageTypes,
                decoratorNames,
                contractMarkerNames,
                includePublicContracts,
                responseTypesToInclude,
                sourceRoot
            );

        if (entryStrategy === "symbols") {
            this.expandTransitiveDependencies(usedLocalImports, fileGraph);
        }

        for (const node of fileGraph.nodes.values()) {
            const content = await this.resolveNodeContent(
                node,
                entryContents,
                usedLocalImports,
                entryStrategy
            );

            if (content === null) {
                continue;
            }

            const transformedContent = this.applyTransformations(
                content,
                node,
                fileGraph,
                sourceRoot,
                removeDecorators,
                responseTypesToExport,
                publicContractsToExport,
                decoratorNames,
                contractMarkerNames,
                pathAliasRewrites
            );

            const outputPath = await this.writeOutputFile(
                outputDir,
                node.relativePath,
                transformedContent.content
            );
            copiedFiles.push(outputPath);

            if (transformedContent.rewrites.length > 0) {
                rewrittenImports.set(outputPath, transformedContent.rewrites);
            }
        }

        return { copiedFiles, rewrittenImports };
    }

    private async preprocessEntryFiles(
        fileGraph: FileGraph,
        entryStrategy: EntryStrategy,
        messageTypes: readonly MessageType[] | undefined,
        decoratorNames: DecoratorNames | undefined,
        contractMarkerNames: ContractMarkerNames | undefined,
        includePublicContracts: boolean | undefined,
        responseTypesToInclude: Map<string, string[]> | undefined,
        sourceRoot: string
    ): Promise<{
        entryContents: Map<string, string>;
        usedLocalImports: Set<string>;
    }> {
        const entryContents = new Map<string, string>();
        const usedLocalImports = new Set<string>();

        if (entryStrategy !== "symbols") {
            return { entryContents, usedLocalImports };
        }

        const extractionMessageTypes =
            messageTypes ?? (["event", "command", "query"] as const);
        const extractPublicContracts = includePublicContracts ?? true;
        const markerNames = {
            ...DEFAULT_CONTRACT_MARKER_NAMES,
            ...contractMarkerNames,
        };

        for (const node of fileGraph.nodes.values()) {
            if (!node.isEntryPoint) {
                continue;
            }

            const rawContent = await this.readFileContent(node.absolutePath);

            if (
                !this.shouldExtractEntryFile(
                    rawContent,
                    messageTypes,
                    extractPublicContracts,
                    markerNames.contract,
                    decoratorNames
                )
            ) {
                continue;
            }

            const { content: extractedContent, usedModuleSpecifiers } =
                this.extractSymbolsFromEntry(
                    rawContent,
                    node.absolutePath,
                    extractionMessageTypes,
                    decoratorNames,
                    contractMarkerNames,
                    extractPublicContracts,
                    responseTypesToInclude?.get(node.absolutePath)
                );
            entryContents.set(node.absolutePath, extractedContent);

            for (const specifier of usedModuleSpecifiers) {
                const importInfo = node.imports.find(
                    (i) => i.moduleSpecifier === specifier
                );
                if (importInfo?.resolvedPath && !importInfo.isExternal) {
                    usedLocalImports.add(importInfo.resolvedPath);
                }
            }
        }

        return { entryContents, usedLocalImports };
    }

    private shouldExtractEntryFile(
        content: string,
        messageTypes: readonly MessageType[] | undefined,
        includePublicContracts: boolean,
        contractMarkerName: string,
        decoratorNames: DecoratorNames | undefined
    ): boolean {
        if (
            this.containsSelectedMessageDecorator(
                content,
                messageTypes,
                decoratorNames
            )
        ) {
            return true;
        }

        return (
            includePublicContracts &&
            new RegExp(
                `@${this.escapeRegex(contractMarkerName)}(?:\\s*\\(\\s*\\))?(?![\\w$])`
            ).test(content)
        );
    }

    private containsSelectedMessageDecorator(
        content: string,
        messageTypes: readonly MessageType[] | undefined,
        decoratorNames: DecoratorNames | undefined
    ): boolean {
        const names = { ...DEFAULT_DECORATOR_NAMES, ...decoratorNames };
        const selectedTypes =
            messageTypes ?? (["event", "command", "query"] as const);

        return selectedTypes.some((type) =>
            new RegExp(`@${this.escapeRegex(names[type])}\\s*\\(`).test(content)
        );
    }

    private expandTransitiveDependencies(
        usedLocalImports: Set<string>,
        fileGraph: FileGraph
    ): void {
        let changed = true;
        while (changed) {
            changed = false;
            for (const importPath of usedLocalImports) {
                const node = fileGraph.nodes.get(importPath);
                if (!node) continue;

                for (const imp of node.imports) {
                    const isUnusedLocalImport =
                        imp.resolvedPath &&
                        !imp.isExternal &&
                        !usedLocalImports.has(imp.resolvedPath);

                    if (isUnusedLocalImport) {
                        usedLocalImports.add(imp.resolvedPath!);
                        changed = true;
                    }
                }
            }
        }
    }

    private async resolveNodeContent(
        node: FileNode,
        entryContents: Map<string, string>,
        usedLocalImports: Set<string>,
        entryStrategy: EntryStrategy
    ): Promise<string | null> {
        const entryContent = entryContents.get(node.absolutePath);
        if (node.isEntryPoint && entryContent !== undefined) {
            return entryContent;
        }

        if (node.isEntryPoint) {
            return (
                entryContent ??
                (await this.readFileContent(node.absolutePath))
            );
        }

        const isUnusedDependency =
            entryStrategy === "symbols" && !usedLocalImports.has(node.absolutePath);

        if (isUnusedDependency) {
            return null;
        }

        return await this.readFileContent(node.absolutePath);
    }

    private applyTransformations(
        content: string,
        node: FileNode,
        fileGraph: FileGraph,
        sourceRoot: string,
        removeDecorators: boolean | undefined,
        responseTypesToExport: Map<string, string[]> | undefined,
        publicContractsToExport: Map<string, string[]> | undefined,
        decoratorNames: DecoratorNames | undefined,
        contractMarkerNames: ContractMarkerNames | undefined,
        pathAliasRewrites: Map<string, string> | undefined
    ): { content: string; rewrites: string[] } {
        const rewrites: string[] = [];
        let transformedContent = content;

        transformedContent = this.processExcludedImports(
            transformedContent,
            node,
            fileGraph.excludedPaths,
            rewrites
        );
        transformedContent = this.processDecoratorRemoval(
            transformedContent,
            node.absolutePath,
            removeDecorators,
            decoratorNames,
            contractMarkerNames,
            rewrites
        );
        transformedContent = this.processTypeExports(
            transformedContent,
            node.absolutePath,
            responseTypesToExport?.get(node.absolutePath),
            rewrites
        );
        transformedContent = this.processTypeExports(
            transformedContent,
            node.absolutePath,
            publicContractsToExport?.get(node.absolutePath),
            rewrites
        );
        transformedContent = this.processInternalPathAliases(
            transformedContent,
            node,
            fileGraph,
            sourceRoot,
            rewrites
        );
        transformedContent = this.processExternalPathAliases(
            transformedContent,
            pathAliasRewrites,
            rewrites
        );

        return { content: transformedContent, rewrites };
    }

    

    generateBarrelExport(copiedFiles: string[], outputDir: string): string {
        const lines: string[] = [];
        for (const filePath of copiedFiles) {
            const relativePath = path.relative(outputDir, filePath);
            lines.push(this.createExportStatement(relativePath));
        }
        return lines.sort().join("\n");
    }

    private async readFileContent(absolutePath: string): Promise<string> {
        try {
            return await this.fs.readFile(absolutePath);
        } catch (error) {
            throw new FileReadError(absolutePath, { cause: error });
        }
    }

    private async writeOutputFile(
        outputDir: string,
        relativePath: string,
        content: string
    ): Promise<string> {
        const outputPath = path.join(outputDir, relativePath);
        const outputDirPath = path.dirname(outputPath);

        await this.fs.mkdir(outputDirPath, { recursive: true });

        try {
            await this.fs.writeFile(outputPath, content);
        } catch (error) {
            throw new FileWriteError(outputPath, { cause: error });
        }

        return outputPath;
    }

    private processExcludedImports(
        content: string,
        node: FileNode,
        excludedPaths: Set<string>,
        rewrites: string[]
    ): string {
        if (excludedPaths.size === 0) {
            return content;
        }

        const excludedResult = this.removeExcludedImports(
            content,
            node,
            excludedPaths
        );
        rewrites.push(...excludedResult.changes);
        return excludedResult.content;
    }

    private processDecoratorRemoval(
        content: string,
        filePath: string,
        removeDecorators: boolean | undefined,
        decoratorNames: DecoratorNames | undefined,
        contractMarkerNames: ContractMarkerNames | undefined,
        rewrites: string[]
    ): string {
        if (!removeDecorators) {
            return content;
        }

        const decoratorResult = this.removeContractDecorators(
            content,
            filePath,
            decoratorNames,
            contractMarkerNames
        );
        rewrites.push(...decoratorResult.changes);
        return decoratorResult.content;
    }

    private processTypeExports(
        content: string,
        filePath: string,
        typesToExport: string[] | undefined,
        rewrites: string[]
    ): string {
        if (!typesToExport || typesToExport.length === 0) {
            return content;
        }

        const exportResult = this.addExportToTypes(
            content,
            filePath,
            typesToExport
        );
        rewrites.push(...exportResult.changes);
        return exportResult.content;
    }

    private processInternalPathAliases(
        content: string,
        node: FileNode,
        fileGraph: FileGraph,
        sourceRoot: string,
        rewrites: string[]
    ): string {
        const internalResult = this.rewriteInternalPathAliases(
            content,
            node,
            fileGraph,
            sourceRoot
        );
        rewrites.push(...internalResult.rewrites);
        return internalResult.content;
    }

    private processExternalPathAliases(
        content: string,
        pathAliasRewrites: Map<string, string> | undefined,
        rewrites: string[]
    ): string {
        if (!pathAliasRewrites) {
            return content;
        }

        const aliasResult = this.applyPathAliasRewrites(
            content,
            pathAliasRewrites
        );
        rewrites.push(...aliasResult.rewrites);
        return aliasResult.content;
    }

    private createExportStatement(relativePath: string): string {
        const exportPath =
            "./" + relativePath.replace(TS_EXTENSION_PATTERN, "");
        return `export * from '${exportPath}'`;
    }

    private rewriteInternalPathAliases(
        content: string,
        node: FileNode,
        fileGraph: FileGraph,
        sourceRoot: string
    ): { content: string; rewrites: string[] } {
        let transformedContent = content;
        const appliedRewrites: string[] = [];

        for (const importInfo of node.imports) {
            if (this.isExternalOrRelativeImport(importInfo)) {
                continue;
            }

            const targetNode = this.resolveInternalImport(
                importInfo,
                fileGraph
            );
            if (!targetNode) {
                continue;
            }

            const relativePath = this.computeRelativePath(
                node.relativePath,
                targetNode.relativePath
            );
            const rewriteResult = this.rewriteModuleSpecifier(
                transformedContent,
                importInfo.moduleSpecifier,
                relativePath
            );

            if (rewriteResult.wasRewritten) {
                transformedContent = rewriteResult.content;
                appliedRewrites.push(
                    `${importInfo.moduleSpecifier} → ${relativePath}`
                );
            }
        }

        return { content: transformedContent, rewrites: appliedRewrites };
    }

    private isExternalOrRelativeImport(importInfo: {
        isExternal: boolean;
        moduleSpecifier: string;
    }): boolean {
        return (
            importInfo.isExternal || importInfo.moduleSpecifier.startsWith(".")
        );
    }

    private resolveInternalImport(
        importInfo: { resolvedPath?: string | null },
        fileGraph: FileGraph
    ): FileNode | undefined {
        if (
            !importInfo.resolvedPath ||
            !fileGraph.nodes.has(importInfo.resolvedPath)
        ) {
            return undefined;
        }
        return fileGraph.nodes.get(importInfo.resolvedPath);
    }

    private rewriteModuleSpecifier(
        content: string,
        originalSpecifier: string,
        newSpecifier: string
    ): { content: string; wasRewritten: boolean } {
        const importPattern = new RegExp(
            `(from\\s+['"])${this.escapeRegex(originalSpecifier)}(['"])`,
            "g"
        );

        if (!importPattern.test(content)) {
            return { content, wasRewritten: false };
        }

        const rewrittenContent = content.replace(
            importPattern,
            `$1${newSpecifier}$2`
        );
        return { content: rewrittenContent, wasRewritten: true };
    }

    private computeRelativePath(
        fromRelative: string,
        toRelative: string
    ): string {
        const fromDir = path.dirname(fromRelative);
        let relativePath = path.relative(fromDir, toRelative);

        relativePath = relativePath.replace(TS_EXTENSION_PATTERN, "");

        if (!relativePath.startsWith(".")) {
            relativePath = "./" + relativePath;
        }

        return relativePath;
    }

    private applyPathAliasRewrites(
        content: string,
        rewrites: Map<string, string>
    ): { content: string; rewrites: string[] } {
        let transformedContent = content;
        const appliedRewrites: string[] = [];

        for (const [from, to] of rewrites) {
            if (transformedContent.includes(from)) {
                transformedContent = transformedContent.replace(
                    new RegExp(this.escapeRegex(from), "g"),
                    to
                );
                appliedRewrites.push(`${from} → ${to}`);
            }
        }

        return { content: transformedContent, rewrites: appliedRewrites };
    }

    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    private removeExcludedImports(
        content: string,
        node: FileNode,
        excludedPaths: Set<string>
    ): TransformResult<string> {
        const excludedModuleSpecifiers = this.findExcludedModuleSpecifiers(
            node,
            excludedPaths
        );

        if (excludedModuleSpecifiers.size === 0) {
            return { content, changes: [] };
        }

        const changes = Array.from(excludedModuleSpecifiers).map(
            (specifier) => `removed import: ${specifier}`
        );

        const visitorFactory = this.createExcludedImportsVisitor(
            excludedModuleSpecifiers
        );
        const transformedContent = this.transformSourceFile(
            content,
            node.absolutePath,
            visitorFactory
        );

        return { content: transformedContent, changes };
    }

    private findExcludedModuleSpecifiers(
        node: FileNode,
        excludedPaths: Set<string>
    ): Set<string> {
        const excludedModuleSpecifiers = new Set<string>();
        for (const importInfo of node.imports) {
            if (
                importInfo.resolvedPath &&
                excludedPaths.has(importInfo.resolvedPath)
            ) {
                excludedModuleSpecifiers.add(importInfo.moduleSpecifier);
            }
        }
        return excludedModuleSpecifiers;
    }

    private createExcludedImportsVisitor(
        excludedModuleSpecifiers: Set<string>
    ): (context: ts.TransformationContext) => VisitorFunction {
        return (context: ts.TransformationContext) => {
            const visit: VisitorFunction = (
                node: ts.Node
            ): ts.Node | undefined => {
                if (
                    this.isImportFromExcludedModule(
                        node,
                        excludedModuleSpecifiers
                    )
                ) {
                    return undefined;
                }

                if (
                    this.isExportFromExcludedModule(
                        node,
                        excludedModuleSpecifiers
                    )
                ) {
                    return undefined;
                }

                return ts.visitEachChild(node, visit, context);
            };
            return visit;
        };
    }

    private isImportFromExcludedModule(
        node: ts.Node,
        excludedModules: Set<string>
    ): boolean {
        if (!ts.isImportDeclaration(node)) {
            return false;
        }
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        return excludedModules.has(moduleSpecifier);
    }

    private isExportFromExcludedModule(
        node: ts.Node,
        excludedModules: Set<string>
    ): boolean {
        if (!ts.isExportDeclaration(node) || !node.moduleSpecifier) {
            return false;
        }
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        return excludedModules.has(moduleSpecifier);
    }

    private removeContractDecorators(
        content: string,
        filePath: string,
        decoratorNames?: DecoratorNames,
        contractMarkerNames?: ContractMarkerNames
    ): TransformResult<string> {
        const changes: string[] = [];
        const contractDecoratorNames = this.buildContractDecoratorNames(
            decoratorNames,
            contractMarkerNames
        );
        const contentWithoutMarkerComments = this.removeContractMarkerComments(
            content,
            contractDecoratorNames,
            changes
        );

        const visitorFactory = this.createDecoratorRemovalVisitor(
            contractDecoratorNames,
            changes
        );
        const transformedContent = this.transformSourceFile(
            contentWithoutMarkerComments,
            filePath,
            visitorFactory
        );

        return { content: transformedContent, changes };
    }

    private buildContractDecoratorNames(
        decoratorNames?: DecoratorNames,
        contractMarkerNames?: ContractMarkerNames
    ): Set<string> {
        const mergedDecoratorNames = {
            ...DEFAULT_DECORATOR_NAMES,
            ...decoratorNames,
        };
        const mergedContractMarkerNames = {
            ...DEFAULT_CONTRACT_MARKER_NAMES,
            ...contractMarkerNames,
        };

        return new Set([
            ...Object.values(DEFAULT_DECORATOR_NAMES),
            ...Object.values(mergedDecoratorNames),
            DEFAULT_CONTRACT_MARKER_NAMES.contract,
            mergedContractMarkerNames.contract,
        ]);
    }

    private removeContractMarkerComments(
        content: string,
        markerNames: Set<string>,
        changes: string[]
    ): string {
        let transformedContent = content;

        for (const markerName of markerNames) {
            const escapedMarkerName = this.escapeRegex(markerName);
            const markerPattern = `@${escapedMarkerName}(?:\\s*\\(\\s*\\))?`;
            const commentPatterns = [
                new RegExp(
                    `^[ \\t]*//[ \\t]*${markerPattern}[ \\t]*(?:\\r?\\n|$)`,
                    "gm"
                ),
                new RegExp(
                    `^[ \\t]*/\\*[ \\t]*${markerPattern}[ \\t]*\\*/[ \\t]*(?:\\r?\\n|$)`,
                    "gm"
                ),
                new RegExp(
                    `^[ \\t]*/\\*\\*[ \\t]*${markerPattern}[ \\t]*\\*/[ \\t]*(?:\\r?\\n|$)`,
                    "gm"
                ),
                new RegExp(
                    `^[ \\t]*\\*[ \\t]*${markerPattern}[ \\t]*(?:\\r?\\n|$)`,
                    "gm"
                ),
            ];

            for (const pattern of commentPatterns) {
                if (pattern.test(transformedContent)) {
                    changes.push(`removed marker comment: @${markerName}`);
                    transformedContent = transformedContent.replace(
                        pattern,
                        ""
                    );
                }
            }
        }

        return transformedContent;
    }

    private createDecoratorRemovalVisitor(
        contractDecoratorNames: Set<string>,
        changes: string[]
    ): (context: ts.TransformationContext) => VisitorFunction {
        return (context: ts.TransformationContext) => {
            const visit: VisitorFunction = (
                node: ts.Node
            ): ts.Node | undefined => {
                if (ts.isImportDeclaration(node)) {
                    return this.processContractDecoratorImport(
                        node,
                        contractDecoratorNames,
                        changes
                    );
                }

                if (ts.isClassDeclaration(node) && node.modifiers) {
                    return this.removeContractDecoratorsFromClass(
                        node,
                        contractDecoratorNames,
                        changes
                    );
                }

                return ts.visitEachChild(node, visit, context);
            };
            return visit;
        };
    }

    private processContractDecoratorImport(
        node: ts.ImportDeclaration,
        contractDecoratorNames: Set<string>,
        changes: string[]
    ): ts.ImportDeclaration | undefined {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;

        const isContractDecoratorModule =
            moduleSpecifier === CONTRACTS_ROOT_MODULE ||
            moduleSpecifier === CONTRACTS_DECORATORS_MODULE ||
            moduleSpecifier === CONTRACTS_GENERATOR_MODULE ||
            moduleSpecifier.startsWith(CONTRACTS_GENERATOR_MODULE + "/");

        if (!isContractDecoratorModule) {
            return node;
        }

        const namedBindings = node.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
            return node;
        }

        const remainingElements = namedBindings.elements.filter(
            (el) => !contractDecoratorNames.has(el.name.text)
        );

        if (remainingElements.length === 0) {
            changes.push(`removed import: ${moduleSpecifier}`);
            return undefined;
        }

        if (remainingElements.length < namedBindings.elements.length) {
            changes.push(`removed decorators from import: ${moduleSpecifier}`);
            return this.createImportWithFilteredBindings(
                node,
                remainingElements
            );
        }

        return node;
    }

    private createImportWithFilteredBindings(
        originalImport: ts.ImportDeclaration,
        remainingElements: ts.ImportSpecifier[]
    ): ts.ImportDeclaration {
        const newNamedImports =
            ts.factory.createNamedImports(remainingElements);
        const newImportClause = ts.factory.createImportClause(
            originalImport.importClause!.isTypeOnly,
            originalImport.importClause!.name,
            newNamedImports
        );
        return ts.factory.createImportDeclaration(
            originalImport.modifiers,
            newImportClause,
            originalImport.moduleSpecifier,
            originalImport.attributes
        );
    }

    private removeContractDecoratorsFromClass(
        node: ts.ClassDeclaration,
        contractDecoratorNames: Set<string>,
        changes: string[]
    ): ts.ClassDeclaration {
        const filteredModifiers = node.modifiers!.filter((modifier) => {
            if (!ts.isDecorator(modifier)) {
                return true;
            }

            const decoratorName = this.extractDecoratorName(modifier);
            if (
                decoratorName &&
                contractDecoratorNames.has(decoratorName)
            ) {
                const decoratorSuffix = this.isDecoratorCallExpression(modifier)
                    ? "()"
                    : "";
                changes.push(
                    `removed decorator: @${decoratorName}${decoratorSuffix}`
                );
                return false;
            }

            return true;
        });

        if (filteredModifiers.length === node.modifiers!.length) {
            return node;
        }

        return ts.factory.createClassDeclaration(
            filteredModifiers,
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        );
    }

    private extractDecoratorName(decorator: ts.Decorator): string | undefined {
        const expression = decorator.expression;

        if (
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression)
        ) {
            return expression.expression.text;
        }

        if (ts.isIdentifier(expression)) {
            return expression.text;
        }

        return undefined;
    }

    private isDecoratorCallExpression(decorator: ts.Decorator): boolean {
        return ts.isCallExpression(decorator.expression);
    }

    private hasExportModifier(
        node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }
    ): boolean {
        return (
            node.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword
            ) ?? false
        );
    }

    private prependExportModifier(
        modifiers: ts.NodeArray<ts.ModifierLike> | undefined
    ): ts.ModifierLike[] {
        const exportModifier = ts.factory.createModifier(
            ts.SyntaxKind.ExportKeyword
        );
        return modifiers ? [exportModifier, ...modifiers] : [exportModifier];
    }

    private addExportToTypes(
        content: string,
        filePath: string,
        typeNames: string[]
    ): TransformResult<string> {
        const changes: string[] = [];
        const typeNamesSet = new Set(typeNames);

        const visitorFactory = this.createExportAdditionVisitor(
            typeNamesSet,
            changes
        );
        const transformedContent = this.transformSourceFile(
            content,
            filePath,
            visitorFactory
        );

        return { content: transformedContent, changes };
    }

    private createExportAdditionVisitor(
        typeNamesSet: Set<string>,
        changes: string[]
    ): (context: ts.TransformationContext) => VisitorFunction {
        return (context: ts.TransformationContext) => {
            const visit: VisitorFunction = (node: ts.Node): ts.Node => {
                if (ts.isTypeAliasDeclaration(node)) {
                    return this.addExportToTypeAlias(
                        node,
                        typeNamesSet,
                        changes
                    );
                }

                if (ts.isInterfaceDeclaration(node)) {
                    return this.addExportToInterface(
                        node,
                        typeNamesSet,
                        changes
                    );
                }

                if (ts.isClassDeclaration(node)) {
                    return this.addExportToClass(
                        node,
                        typeNamesSet,
                        changes
                    );
                }

                if (ts.isEnumDeclaration(node)) {
                    return this.addExportToEnum(
                        node,
                        typeNamesSet,
                        changes
                    );
                }

                return ts.visitEachChild(node, visit, context);
            };
            return visit;
        };
    }

    private addExportToTypeAlias(
        node: ts.TypeAliasDeclaration,
        typeNamesSet: Set<string>,
        changes: string[]
    ): ts.TypeAliasDeclaration {
        const typeName = node.name.text;

        if (!typeNamesSet.has(typeName) || this.hasExportModifier(node)) {
            return node;
        }

        changes.push(`added export: type ${typeName}`);
        return ts.factory.createTypeAliasDeclaration(
            this.prependExportModifier(node.modifiers),
            node.name,
            node.typeParameters,
            node.type
        );
    }

    private addExportToInterface(
        node: ts.InterfaceDeclaration,
        typeNamesSet: Set<string>,
        changes: string[]
    ): ts.InterfaceDeclaration {
        const typeName = node.name.text;

        if (!typeNamesSet.has(typeName) || this.hasExportModifier(node)) {
            return node;
        }

        changes.push(`added export: interface ${typeName}`);
        return ts.factory.createInterfaceDeclaration(
            this.prependExportModifier(node.modifiers),
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        );
    }

    private addExportToClass(
        node: ts.ClassDeclaration,
        typeNamesSet: Set<string>,
        changes: string[]
    ): ts.ClassDeclaration {
        const className = node.name?.text;

        if (!className || !typeNamesSet.has(className) || this.hasExportModifier(node)) {
            return node;
        }

        changes.push(`added export: class ${className}`);
        return ts.factory.createClassDeclaration(
            this.prependExportModifier(node.modifiers),
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        );
    }

    private addExportToEnum(
        node: ts.EnumDeclaration,
        typeNamesSet: Set<string>,
        changes: string[]
    ): ts.EnumDeclaration {
        const enumName = node.name.text;

        if (!typeNamesSet.has(enumName) || this.hasExportModifier(node)) {
            return node;
        }

        changes.push(`added export: enum ${enumName}`);
        return ts.factory.createEnumDeclaration(
            this.prependExportModifier(node.modifiers),
            node.name,
            node.members
        );
    }

    private transformSourceFile(
        content: string,
        filePath: string,
        visitorFactory: (context: ts.TransformationContext) => VisitorFunction
    ): string {
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
            return (sf) => {
                const visitor = visitorFactory(context);
                return ts.visitNode(sf, visitor) as ts.SourceFile;
            };
        };

        const result = ts.transform(sourceFile, [transformer]);
        const transformedSourceFile = result.transformed[0];

        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
        const transformedContent = printer.printFile(transformedSourceFile);

        result.dispose();

        return transformedContent;
    }

    private extractSymbolsFromEntry(
        content: string,
        filePath: string,
        messageTypes: readonly MessageType[],
        decoratorNames?: DecoratorNames,
        contractMarkerNames?: ContractMarkerNames,
        includePublicContracts = true,
        responseTypeNames: readonly string[] = []
    ): { content: string; usedModuleSpecifiers: Set<string> } {
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        const decoratorToMessageType =
            this.buildDecoratorToMessageTypeMap(decoratorNames);
        const markerNames = {
            ...DEFAULT_CONTRACT_MARKER_NAMES,
            ...contractMarkerNames,
        };
        const context: SymbolExtractionContext = {
            sourceFile,
            content,
            messageTypes,
            decoratorToMessageType,
            contractMarkerName: markerNames.contract,
            includePublicContracts,
        };

        const { targetClassNames, targetDeclarations } =
            this.findTargetDeclarations(context);

        if (targetDeclarations.length === 0) {
            return { content, usedModuleSpecifiers: new Set() };
        }

        const relatedTypeNames = this.computeRelatedTypeNames(
            targetClassNames,
            responseTypeNames
        );
        const usedIdentifiers = this.collectUsedIdentifiers(targetDeclarations);
        const localTypeDeclarations =
            this.collectLocalTypeDeclarations(sourceFile);
        const includedLocalTypes = this.resolveIncludedLocalTypes(
            usedIdentifiers,
            relatedTypeNames,
            localTypeDeclarations
        );

        const extractedSymbols: ExtractedSymbols = {
            targetClassNames,
            targetDeclarations,
            usedIdentifiers,
            includedLocalTypes,
            localTypeDeclarations,
        };

        return this.generateExtractedOutput(context, extractedSymbols);
    }

    private buildDecoratorToMessageTypeMap(
        decoratorNames?: DecoratorNames
    ): Record<string, MessageType> {
        const names = { ...DEFAULT_DECORATOR_NAMES, ...decoratorNames };
        return {
            [names.event]: "event",
            [names.command]: "command",
            [names.query]: "query",
        };
    }

    private findTargetDeclarations(context: SymbolExtractionContext): {
        targetClassNames: Set<string>;
        targetDeclarations: ts.Node[];
    } {
        const targetClassNames = new Set<string>();
        const targetDeclarations: ts.Node[] = [];

        const findDeclarations = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                const isPublicContract =
                    context.includePublicContracts &&
                    (hasDecorator(node, context.contractMarkerName) ||
                        hasLeadingCommentMarker(
                            node,
                            context.content,
                            context.contractMarkerName
                        ));

                for (const [decoratorName, messageType] of Object.entries(
                    context.decoratorToMessageType
                )) {
                    if (
                        hasDecorator(node, decoratorName) &&
                        context.messageTypes.includes(messageType)
                    ) {
                        targetClassNames.add(node.name.text);
                        targetDeclarations.push(node);
                        return;
                    }
                }

                if (isPublicContract) {
                    targetDeclarations.push(node);
                    return;
                }
            }

            if (
                context.includePublicContracts &&
                this.isPublicContractTypeDeclaration(node, context)
            ) {
                targetDeclarations.push(node);
                return;
            }

            ts.forEachChild(node, findDeclarations);
        };
        findDeclarations(context.sourceFile);

        return { targetClassNames, targetDeclarations };
    }

    private isPublicContractTypeDeclaration(
        node: ts.Node,
        context: SymbolExtractionContext
    ): boolean {
        const isSupportedDeclaration =
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isEnumDeclaration(node);

        return (
            isSupportedDeclaration &&
            hasLeadingCommentMarker(
                node,
                context.content,
                context.contractMarkerName
            )
        );
    }

    private computeRelatedTypeNames(
        targetClassNames: Set<string>,
        responseTypeNames: readonly string[] = []
    ): Set<string> {
        const relatedTypeNames = new Set<string>(responseTypeNames);

        for (const className of targetClassNames) {
            if (className.endsWith(REQUEST_SUFFIX)) {
                const baseName = className.slice(0, -REQUEST_SUFFIX.length);
                relatedTypeNames.add(baseName + "Response");
                relatedTypeNames.add(baseName + "Payload");
            } else if (className.endsWith(QUERY_SUFFIX)) {
                const baseName = className.slice(0, -QUERY_SUFFIX.length);
                relatedTypeNames.add(baseName + "QueryResult");
                relatedTypeNames.add(baseName + "Payload");
            }

            relatedTypeNames.add(className + "Response");
            relatedTypeNames.add(className + "Payload");
        }

        return relatedTypeNames;
    }

    private collectUsedIdentifiers(
        targetDeclarations: ts.Node[]
    ): Set<string> {
        const usedIdentifiers = new Set<string>();

        const collectIdentifiers = (node: ts.Node): void => {
            this.collectReferencedIdentifier(node, usedIdentifiers);
            ts.forEachChild(node, collectIdentifiers);
        };

        for (const declaration of targetDeclarations) {
            collectIdentifiers(declaration);
        }

        return usedIdentifiers;
    }

    private collectReferencedIdentifier(
        node: ts.Node,
        usedIdentifiers: Set<string>
    ): void {
        if (ts.isTypeReferenceNode(node)) {
            this.collectEntityNameRootIdentifier(
                node.typeName,
                usedIdentifiers
            );
        }
        if (ts.isExpressionWithTypeArguments(node)) {
            this.collectExpressionRootIdentifier(
                node.expression,
                usedIdentifiers
            );
        }
        if (ts.isDecorator(node)) {
            this.collectDecoratorIdentifier(node, usedIdentifiers);
        }
        if (
            ts.isCallExpression(node) ||
            ts.isNewExpression(node) ||
            ts.isPropertyAccessExpression(node)
        ) {
            this.collectExpressionRootIdentifier(
                node.expression,
                usedIdentifiers
            );
        }
        if (
            ts.isIdentifier(node) &&
            this.isRuntimeReferenceIdentifier(node)
        ) {
            usedIdentifiers.add(node.text);
        }
    }

    private collectEntityNameRootIdentifier(
        entityName: ts.EntityName,
        usedIdentifiers: Set<string>
    ): void {
        let current: ts.EntityName = entityName;

        while (ts.isQualifiedName(current)) {
            current = current.left;
        }

        usedIdentifiers.add(current.text);
    }

    private collectExpressionRootIdentifier(
        expression: ts.Expression,
        usedIdentifiers: Set<string>
    ): void {
        let current: ts.Expression = expression;

        while (ts.isPropertyAccessExpression(current)) {
            current = current.expression;
        }

        if (ts.isIdentifier(current)) {
            usedIdentifiers.add(current.text);
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

    private collectDecoratorIdentifier(
        decorator: ts.Decorator,
        usedIdentifiers: Set<string>
    ): void {
        const expr = decorator.expression;
        if (ts.isIdentifier(expr)) {
            usedIdentifiers.add(expr.text);
        } else if (
            ts.isCallExpression(expr) &&
            ts.isIdentifier(expr.expression)
        ) {
            usedIdentifiers.add(expr.expression.text);
        }
    }

    private collectLocalTypeDeclarations(
        sourceFile: ts.SourceFile
    ): Map<string, ts.Node[]> {
        const localTypeDeclarations = new Map<string, ts.Node[]>();

        for (const statement of sourceFile.statements) {
            if (ts.isInterfaceDeclaration(statement) && statement.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    statement.name.text,
                    statement
                );
            }
            if (ts.isTypeAliasDeclaration(statement) && statement.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    statement.name.text,
                    statement
                );
            }
            if (ts.isVariableStatement(statement)) {
                for (const decl of statement.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        this.addToDeclarationMap(
                            localTypeDeclarations,
                            decl.name.text,
                            statement
                        );
                    }
                }
            }
            if (ts.isClassDeclaration(statement) && statement.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    statement.name.text,
                    statement
                );
            }
            if (ts.isFunctionDeclaration(statement) && statement.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    statement.name.text,
                    statement
                );
            }
            if (ts.isEnumDeclaration(statement) && statement.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    statement.name.text,
                    statement
                );
            }
        }

        return localTypeDeclarations;
    }

    private addToDeclarationMap(
        map: Map<string, ts.Node[]>,
        name: string,
        node: ts.Node
    ): void {
        const existing = map.get(name) ?? [];
        existing.push(node);
        map.set(name, existing);
    }

    private resolveIncludedLocalTypes(
        usedIdentifiers: Set<string>,
        relatedTypeNames: Set<string>,
        localTypeDeclarations: Map<string, ts.Node[]>
    ): Set<string> {
        const includedLocalTypes = new Set<string>();
        const queue = [...usedIdentifiers, ...relatedTypeNames];

        while (queue.length > 0) {
            const identifier = queue.shift()!;
            if (includedLocalTypes.has(identifier)) continue;

            const typeNodes = localTypeDeclarations.get(identifier);
            if (!typeNodes || typeNodes.length === 0) continue;

            includedLocalTypes.add(identifier);

            const typeIdentifiers =
                this.collectReferencedIdentifiersFromNodes(typeNodes);
            for (const id of typeIdentifiers) {
                if (!includedLocalTypes.has(id)) {
                    queue.push(id);
                    usedIdentifiers.add(id);
                }
            }
        }

        return includedLocalTypes;
    }

    private collectReferencedIdentifiersFromNodes(nodes: ts.Node[]): Set<string> {
        const typeIdentifiers = new Set<string>();

        const collectFromType = (node: ts.Node): void => {
            this.collectReferencedIdentifier(node, typeIdentifiers);
            if (ts.isComputedPropertyName(node)) {
                this.collectComputedPropertyIdentifier(node, typeIdentifiers);
            }
            ts.forEachChild(node, collectFromType);
        };

        for (const typeNode of nodes) {
            collectFromType(typeNode);
        }

        return typeIdentifiers;
    }

    private collectComputedPropertyIdentifier(
        node: ts.ComputedPropertyName,
        typeIdentifiers: Set<string>
    ): void {
        const expr = node.expression;
        if (
            ts.isPropertyAccessExpression(expr) &&
            ts.isIdentifier(expr.expression)
        ) {
            typeIdentifiers.add(expr.expression.text);
        }
        if (ts.isIdentifier(expr)) {
            typeIdentifiers.add(expr.text);
        }
    }

    private generateExtractedOutput(
        context: SymbolExtractionContext,
        symbols: ExtractedSymbols
    ): { content: string; usedModuleSpecifiers: Set<string> } {
        const output: string[] = [];

        const importMap = this.buildImportMap(context.sourceFile);
        const filteredImports = this.filterImports(
            symbols.usedIdentifiers,
            importMap,
            symbols.includedLocalTypes
        );

        this.appendImportStatements(
            output,
            filteredImports,
            context.sourceFile
        );
        const emittedNodes = new Set<ts.Node>(symbols.targetDeclarations);
        this.appendLocalTypeDeclarations(output, context, symbols, emittedNodes);
        this.appendTargetDeclarations(
            output,
            context,
            symbols.targetDeclarations
        );

        const usedModuleSpecifiers = new Set(
            filteredImports.map(
                (importDeclaration) =>
                    (importDeclaration.moduleSpecifier as ts.StringLiteral).text
            )
        );

        return {
            content: output.join("\n"),
            usedModuleSpecifiers,
        };
    }

    private buildImportMap(sourceFile: ts.SourceFile): ImportInfo[] {
        const importMap: ImportInfo[] = [];

        const collectImports = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                const importInfo = this.createImportInfo(node);

                if (importInfo) {
                    importMap.push(importInfo);
                }
            }
            ts.forEachChild(node, collectImports);
        };
        collectImports(sourceFile);

        return importMap;
    }

    private createImportInfo(
        declaration: ts.ImportDeclaration
    ): ImportInfo | undefined {
        if (!ts.isStringLiteral(declaration.moduleSpecifier)) {
            return undefined;
        }

        const importClause = declaration.importClause;
        if (!importClause) {
            return undefined;
        }

        const localNames = new Set<string>();

        if (importClause.name) {
            localNames.add(importClause.name.text);
        }

        const namedBindings = importClause.namedBindings;
        if (namedBindings) {
            if (ts.isNamespaceImport(namedBindings)) {
                localNames.add(namedBindings.name.text);
            } else {
                for (const element of namedBindings.elements) {
                    localNames.add(element.name.text);
                }
            }
        }

        if (localNames.size === 0) {
            return undefined;
        }

        return {
            declaration,
            moduleSpecifier: declaration.moduleSpecifier.text,
            localNames,
        };
    }

    private filterImports(
        usedIdentifiers: Set<string>,
        importMap: ImportInfo[],
        includedLocalTypes: Set<string>
    ): ts.ImportDeclaration[] {
        const usedImportIdentifiers = new Set(
            [...usedIdentifiers].filter(
                (identifier) => !includedLocalTypes.has(identifier)
            )
        );

        return importMap
            .filter((importInfo) =>
                [...importInfo.localNames].some((localName) =>
                    usedImportIdentifiers.has(localName)
                )
            )
            .map((importInfo) =>
                this.filterImportDeclaration(
                    importInfo.declaration,
                    usedImportIdentifiers
                )
            )
            .filter(
                (
                    importDeclaration
                ): importDeclaration is ts.ImportDeclaration =>
                    importDeclaration !== undefined
            );
    }

    private filterImportDeclaration(
        declaration: ts.ImportDeclaration,
        usedIdentifiers: Set<string>
    ): ts.ImportDeclaration | undefined {
        const importClause = declaration.importClause;
        if (!importClause) {
            return undefined;
        }

        const filteredImportClause = this.filterImportClause(
            importClause,
            usedIdentifiers
        );
        if (!filteredImportClause) {
            return undefined;
        }

        return ts.factory.updateImportDeclaration(
            declaration,
            declaration.modifiers,
            filteredImportClause,
            declaration.moduleSpecifier,
            declaration.attributes
        );
    }

    private filterImportClause(
        importClause: ts.ImportClause,
        usedIdentifiers: Set<string>
    ): ts.ImportClause | undefined {
        const defaultImportName =
            importClause.name && usedIdentifiers.has(importClause.name.text)
                ? importClause.name
                : undefined;
        const namedBindings = this.filterNamedImportBindings(
            importClause.namedBindings,
            usedIdentifiers
        );

        if (!defaultImportName && !namedBindings) {
            return undefined;
        }

        return ts.factory.updateImportClause(
            importClause,
            importClause.isTypeOnly,
            defaultImportName,
            namedBindings
        );
    }

    private filterNamedImportBindings(
        namedBindings: ts.NamedImportBindings | undefined,
        usedIdentifiers: Set<string>
    ): ts.NamedImportBindings | undefined {
        if (!namedBindings) {
            return undefined;
        }

        if (ts.isNamespaceImport(namedBindings)) {
            return usedIdentifiers.has(namedBindings.name.text)
                ? namedBindings
                : undefined;
        }

        const retainedElements = namedBindings.elements.filter((element) =>
            usedIdentifiers.has(element.name.text)
        );

        if (retainedElements.length === 0) {
            return undefined;
        }

        if (retainedElements.length === namedBindings.elements.length) {
            return namedBindings;
        }

        return ts.factory.updateNamedImports(
            namedBindings,
            retainedElements
        );
    }

    private appendImportStatements(
        output: string[],
        filteredImports: ts.ImportDeclaration[],
        sourceFile: ts.SourceFile
    ): void {
        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

        for (const importDeclaration of filteredImports) {
            output.push(
                printer
                    .printNode(
                        ts.EmitHint.Unspecified,
                        importDeclaration,
                        sourceFile
                    )
                    .trim()
            );
        }

        if (output.length > 0) {
            output.push("");
        }
    }

    private appendLocalTypeDeclarations(
        output: string[],
        context: SymbolExtractionContext,
        symbols: ExtractedSymbols,
        emittedNodes: Set<ts.Node>
    ): void {
        for (const typeName of symbols.includedLocalTypes) {
            const typeNodes = symbols.localTypeDeclarations.get(typeName);
            if (!typeNodes) continue;

            for (const typeNode of typeNodes) {
                if (emittedNodes.has(typeNode)) continue;
                emittedNodes.add(typeNode);

                this.appendNodeWithExport(output, context, typeNode);
            }
        }
    }

    private appendTargetDeclarations(
        output: string[],
        context: SymbolExtractionContext,
        targetDeclarations: ts.Node[]
    ): void {
        for (const declaration of targetDeclarations) {
            if (
                ts.isClassDeclaration(declaration) &&
                this.isPublicContractClassDeclaration(declaration, context)
            ) {
                this.appendClassWithExport(output, context, declaration);
                continue;
            }

            this.appendNodeWithExport(output, context, declaration);
        }
    }

    private appendClassWithExport(
        output: string[],
        context: SymbolExtractionContext,
        node: ts.ClassDeclaration
    ): void {
        const exportableClassNode = this.ensureClassExport(node);
        const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
        output.push(
            printer
                .printNode(
                    ts.EmitHint.Unspecified,
                    exportableClassNode,
                    context.sourceFile
                )
                .trim()
        );
        output.push("");
    }

    private ensureClassExport(node: ts.ClassDeclaration): ts.ClassDeclaration {
        if (this.nodeHasExportKeyword(node)) {
            return node;
        }

        return ts.factory.updateClassDeclaration(
            node,
            this.prependExportModifier(node.modifiers),
            node.name,
            node.typeParameters,
            node.heritageClauses,
            node.members
        );
    }

    private isPublicContractClassDeclaration(
        node: ts.ClassDeclaration,
        context: SymbolExtractionContext
    ): boolean {
        return (
            hasDecorator(node, context.contractMarkerName) ||
            hasLeadingCommentMarker(
                node,
                context.content,
                context.contractMarkerName
            )
        );
    }

    private appendNodeWithExport(
        output: string[],
        context: SymbolExtractionContext,
        node: ts.Node
    ): void {
        const nodeText = context.content
            .substring(node.getStart(context.sourceFile), node.end)
            .trim();

        const hasExport = this.nodeHasExportKeyword(node);

        if (hasExport) {
            output.push(nodeText);
        } else {
            output.push("export " + nodeText);
        }
        output.push("");
    }

    private nodeHasExportKeyword(node: ts.Node): boolean {
        const isExportableDeclaration =
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isVariableStatement(node) ||
            ts.isClassDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isEnumDeclaration(node);

        if (!isExportableDeclaration) {
            return false;
        }

        const declarationNode = node as
            | ts.InterfaceDeclaration
            | ts.TypeAliasDeclaration
            | ts.VariableStatement
            | ts.ClassDeclaration
            | ts.FunctionDeclaration
            | ts.EnumDeclaration;

        return (
            declarationNode.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword
            ) ?? false
        );
    }
}
