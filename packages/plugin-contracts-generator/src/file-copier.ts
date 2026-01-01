import * as path from "path";
import * as ts from "typescript";

import type { FileGraph, FileNode } from "./file-graph-resolver";
import { FileReadError, FileWriteError } from "./errors";
import { FileSystem, nodeFileSystem } from "./file-system";
import type { MessageType, DecoratorNames } from "./domain";
import { DEFAULT_DECORATOR_NAMES } from "./domain";
import { hasDecorator } from "./class-analyzer";

const CONTRACTS_GENERATOR_MODULE = "@hexaijs/plugin-contracts-generator";
const CONTRACT_DECORATORS = new Set([
    "PublicCommand",
    "PublicEvent",
    "PublicQuery",
]);
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
    messageTypes?: readonly MessageType[];
    decoratorNames?: DecoratorNames;
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
}

interface ExtractedSymbols {
    targetClassNames: Set<string>;
    targetClasses: ts.ClassDeclaration[];
    usedIdentifiers: Set<string>;
    includedLocalTypes: Set<string>;
    localTypeDeclarations: Map<string, ts.Node[]>;
}

interface ImportInfo {
    moduleSpecifier: string;
    isTypeOnly: boolean;
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
            messageTypes,
            decoratorNames,
        } = options;
        const copiedFiles: string[] = [];
        const rewrittenImports = new Map<string, string[]>();

        const { entryContents, usedLocalImports } =
            await this.preprocessEntryFiles(
                fileGraph,
                messageTypes,
                decoratorNames,
                sourceRoot
            );

        this.expandTransitiveDependencies(usedLocalImports, fileGraph);

        for (const node of fileGraph.nodes.values()) {
            const content = await this.resolveNodeContent(
                node,
                entryContents,
                usedLocalImports,
                messageTypes
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
        messageTypes: readonly MessageType[] | undefined,
        decoratorNames: DecoratorNames | undefined,
        sourceRoot: string
    ): Promise<{
        entryContents: Map<string, string>;
        usedLocalImports: Set<string>;
    }> {
        const entryContents = new Map<string, string>();
        const usedLocalImports = new Set<string>();

        if (!messageTypes?.length) {
            return { entryContents, usedLocalImports };
        }

        for (const node of fileGraph.nodes.values()) {
            if (!node.isEntryPoint) {
                continue;
            }

            const rawContent = await this.readFileContent(node.absolutePath);
            const extractedContent = this.extractSymbolsFromEntry(
                rawContent,
                node.absolutePath,
                messageTypes,
                decoratorNames
            );
            entryContents.set(node.absolutePath, extractedContent);

            const { content: contentWithRelativePaths } =
                this.rewriteInternalPathAliases(
                    extractedContent,
                    node,
                    fileGraph,
                    sourceRoot
                );

            const localImports = this.extractLocalImportPaths(
                contentWithRelativePaths,
                node.absolutePath
            );
            for (const importPath of localImports) {
                usedLocalImports.add(importPath);
            }
        }

        return { entryContents, usedLocalImports };
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
        messageTypes: readonly MessageType[] | undefined
    ): Promise<string | null> {
        if (node.isEntryPoint && messageTypes?.length) {
            return (
                entryContents.get(node.absolutePath) ??
                (await this.readFileContent(node.absolutePath))
            );
        }

        const isUnusedDependency =
            messageTypes?.length && !usedLocalImports.has(node.absolutePath);

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
            rewrites
        );
        transformedContent = this.processTypeExports(
            transformedContent,
            node.absolutePath,
            responseTypesToExport?.get(node.absolutePath),
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

    private extractLocalImportPaths(
        content: string,
        sourceFilePath: string
    ): string[] {
        const sourceFile = ts.createSourceFile(
            sourceFilePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        const localPaths: string[] = [];
        const sourceDir = path.dirname(sourceFilePath);

        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                const moduleSpecifier = (
                    node.moduleSpecifier as ts.StringLiteral
                ).text;
                if (moduleSpecifier.startsWith(".")) {
                    let resolvedPath = path.resolve(sourceDir, moduleSpecifier);
                    if (!resolvedPath.endsWith(TS_EXTENSION)) {
                        resolvedPath += TS_EXTENSION;
                    }
                    localPaths.push(resolvedPath);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);

        return localPaths;
    }

    generateBarrelExport(copiedFiles: string[], outputDir: string): string {
        const lines: string[] = [];
        for (const filePath of copiedFiles) {
            const relativePath = path.relative(outputDir, filePath);
            lines.push(this.createExportStatement(relativePath));
        }
        return lines.join("\n");
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
        rewrites: string[]
    ): string {
        if (!removeDecorators) {
            return content;
        }

        const decoratorResult = this.removeContractDecorators(
            content,
            filePath
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
        filePath: string
    ): TransformResult<string> {
        const changes: string[] = [];

        const visitorFactory = this.createDecoratorRemovalVisitor(changes);
        const transformedContent = this.transformSourceFile(
            content,
            filePath,
            visitorFactory
        );

        return { content: transformedContent, changes };
    }

    private createDecoratorRemovalVisitor(
        changes: string[]
    ): (context: ts.TransformationContext) => VisitorFunction {
        return (context: ts.TransformationContext) => {
            const visit: VisitorFunction = (
                node: ts.Node
            ): ts.Node | undefined => {
                if (ts.isImportDeclaration(node)) {
                    return this.processContractGeneratorImport(node, changes);
                }

                if (ts.isClassDeclaration(node) && node.modifiers) {
                    return this.removeContractDecoratorsFromClass(
                        node,
                        changes
                    );
                }

                return ts.visitEachChild(node, visit, context);
            };
            return visit;
        };
    }

    private processContractGeneratorImport(
        node: ts.ImportDeclaration,
        changes: string[]
    ): ts.ImportDeclaration | undefined {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;

        const isContractGeneratorModule =
            moduleSpecifier === CONTRACTS_GENERATOR_MODULE ||
            moduleSpecifier.startsWith(CONTRACTS_GENERATOR_MODULE + "/");

        if (!isContractGeneratorModule) {
            return node;
        }

        const namedBindings = node.importClause?.namedBindings;
        if (!namedBindings || !ts.isNamedImports(namedBindings)) {
            return node;
        }

        const remainingElements = namedBindings.elements.filter(
            (el) => !CONTRACT_DECORATORS.has(el.name.text)
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
        changes: string[]
    ): ts.ClassDeclaration {
        const filteredModifiers = node.modifiers!.filter((modifier) => {
            if (!ts.isDecorator(modifier)) {
                return true;
            }

            const decoratorName = this.extractDecoratorName(modifier);
            if (decoratorName && CONTRACT_DECORATORS.has(decoratorName)) {
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
        decoratorNames?: DecoratorNames
    ): string {
        const sourceFile = ts.createSourceFile(
            filePath,
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );

        const decoratorToMessageType =
            this.buildDecoratorToMessageTypeMap(decoratorNames);
        const context: SymbolExtractionContext = {
            sourceFile,
            content,
            messageTypes,
            decoratorToMessageType,
        };

        const { targetClassNames, targetClasses } =
            this.findTargetClasses(context);

        if (targetClasses.length === 0) {
            return content;
        }

        const relatedTypeNames = this.computeRelatedTypeNames(targetClassNames);
        const usedIdentifiers = this.collectUsedIdentifiers(targetClasses);
        const localTypeDeclarations =
            this.collectLocalTypeDeclarations(sourceFile);
        const includedLocalTypes = this.resolveIncludedLocalTypes(
            usedIdentifiers,
            relatedTypeNames,
            localTypeDeclarations
        );

        const extractedSymbols: ExtractedSymbols = {
            targetClassNames,
            targetClasses,
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

    private findTargetClasses(context: SymbolExtractionContext): {
        targetClassNames: Set<string>;
        targetClasses: ts.ClassDeclaration[];
    } {
        const targetClassNames = new Set<string>();
        const targetClasses: ts.ClassDeclaration[] = [];

        const findClasses = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                for (const [decoratorName, messageType] of Object.entries(
                    context.decoratorToMessageType
                )) {
                    if (
                        hasDecorator(node, decoratorName) &&
                        context.messageTypes.includes(messageType)
                    ) {
                        targetClassNames.add(node.name.text);
                        targetClasses.push(node);
                        break;
                    }
                }
            }
            ts.forEachChild(node, findClasses);
        };
        findClasses(context.sourceFile);

        return { targetClassNames, targetClasses };
    }

    private computeRelatedTypeNames(
        targetClassNames: Set<string>
    ): Set<string> {
        const relatedTypeNames = new Set<string>();

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
        targetClasses: ts.ClassDeclaration[]
    ): Set<string> {
        const usedIdentifiers = new Set<string>();

        const collectIdentifiers = (node: ts.Node): void => {
            if (
                ts.isTypeReferenceNode(node) &&
                ts.isIdentifier(node.typeName)
            ) {
                usedIdentifiers.add(node.typeName.text);
            }
            if (
                ts.isExpressionWithTypeArguments(node) &&
                ts.isIdentifier(node.expression)
            ) {
                usedIdentifiers.add(node.expression.text);
            }
            if (ts.isIdentifier(node) && node.parent) {
                const isHeritageOrTypeRef =
                    ts.isHeritageClause(node.parent.parent) ||
                    ts.isTypeReferenceNode(node.parent);
                if (isHeritageOrTypeRef) {
                    usedIdentifiers.add(node.text);
                }
            }
            if (ts.isDecorator(node)) {
                this.collectDecoratorIdentifier(node, usedIdentifiers);
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                usedIdentifiers.add(node.expression.text);
            }
            ts.forEachChild(node, collectIdentifiers);
        };

        for (const cls of targetClasses) {
            collectIdentifiers(cls);
        }

        return usedIdentifiers;
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

        const collectLocalTypes = (node: ts.Node): void => {
            if (ts.isInterfaceDeclaration(node) && node.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    node.name.text,
                    node
                );
            }
            if (ts.isTypeAliasDeclaration(node) && node.name) {
                this.addToDeclarationMap(
                    localTypeDeclarations,
                    node.name.text,
                    node
                );
            }
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        this.addToDeclarationMap(
                            localTypeDeclarations,
                            decl.name.text,
                            node
                        );
                    }
                }
            }
            ts.forEachChild(node, collectLocalTypes);
        };
        collectLocalTypes(sourceFile);

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
                this.collectTypeIdentifiersFromNodes(typeNodes);
            for (const id of typeIdentifiers) {
                if (!includedLocalTypes.has(id)) {
                    queue.push(id);
                    usedIdentifiers.add(id);
                }
            }
        }

        return includedLocalTypes;
    }

    private collectTypeIdentifiersFromNodes(nodes: ts.Node[]): Set<string> {
        const typeIdentifiers = new Set<string>();

        const collectFromType = (node: ts.Node): void => {
            if (
                ts.isTypeReferenceNode(node) &&
                ts.isIdentifier(node.typeName)
            ) {
                typeIdentifiers.add(node.typeName.text);
            }
            if (
                ts.isExpressionWithTypeArguments(node) &&
                ts.isIdentifier(node.expression)
            ) {
                typeIdentifiers.add(node.expression.text);
            }
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
    ): string {
        const output: string[] = [];

        const importMap = this.buildImportMap(context.sourceFile);
        const filteredImports = this.filterImports(
            symbols.usedIdentifiers,
            importMap,
            symbols.includedLocalTypes
        );

        this.appendImportStatements(output, filteredImports);
        this.appendLocalTypeDeclarations(output, context, symbols);
        this.appendTargetClasses(output, context, symbols.targetClasses);

        return output.join("\n");
    }

    private buildImportMap(sourceFile: ts.SourceFile): Map<string, ImportInfo> {
        const importMap = new Map<string, ImportInfo>();

        const collectImports = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node)) {
                const moduleSpecifier = (
                    node.moduleSpecifier as ts.StringLiteral
                ).text;
                const namedBindings = node.importClause?.namedBindings;
                const isTypeOnly = node.importClause?.isTypeOnly ?? false;

                if (namedBindings && ts.isNamedImports(namedBindings)) {
                    for (const element of namedBindings.elements) {
                        importMap.set(element.name.text, {
                            moduleSpecifier,
                            isTypeOnly,
                        });
                    }
                }
            }
            ts.forEachChild(node, collectImports);
        };
        collectImports(sourceFile);

        return importMap;
    }

    private filterImports(
        usedIdentifiers: Set<string>,
        importMap: Map<string, ImportInfo>,
        includedLocalTypes: Set<string>
    ): Map<string, { identifiers: Set<string>; isTypeOnly: boolean }> {
        const filteredImports = new Map<
            string,
            { identifiers: Set<string>; isTypeOnly: boolean }
        >();

        for (const identifier of usedIdentifiers) {
            const importInfo = importMap.get(identifier);
            if (!importInfo || includedLocalTypes.has(identifier)) {
                continue;
            }

            const existing = filteredImports.get(importInfo.moduleSpecifier);
            if (existing) {
                existing.identifiers.add(identifier);
            } else {
                filteredImports.set(importInfo.moduleSpecifier, {
                    identifiers: new Set([identifier]),
                    isTypeOnly: importInfo.isTypeOnly,
                });
            }
        }

        return filteredImports;
    }

    private appendImportStatements(
        output: string[],
        filteredImports: Map<
            string,
            { identifiers: Set<string>; isTypeOnly: boolean }
        >
    ): void {
        for (const [moduleSpecifier, info] of filteredImports) {
            const identifiers = [...info.identifiers].sort().join(", ");
            const typeOnlyPrefix = info.isTypeOnly ? "type " : "";
            output.push(
                `import ${typeOnlyPrefix}{ ${identifiers} } from "${moduleSpecifier}";`
            );
        }

        if (output.length > 0) {
            output.push("");
        }
    }

    private appendLocalTypeDeclarations(
        output: string[],
        context: SymbolExtractionContext,
        symbols: ExtractedSymbols
    ): void {
        const outputNodes = new Set<ts.Node>();

        for (const typeName of symbols.includedLocalTypes) {
            const typeNodes = symbols.localTypeDeclarations.get(typeName);
            if (!typeNodes) continue;

            for (const typeNode of typeNodes) {
                if (outputNodes.has(typeNode)) continue;
                outputNodes.add(typeNode);

                this.appendNodeWithExport(output, context, typeNode);
            }
        }
    }

    private appendTargetClasses(
        output: string[],
        context: SymbolExtractionContext,
        targetClasses: ts.ClassDeclaration[]
    ): void {
        for (const cls of targetClasses) {
            this.appendNodeWithExport(output, context, cls);
        }
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
            ts.isClassDeclaration(node);

        if (!isExportableDeclaration) {
            return false;
        }

        const declarationNode = node as
            | ts.InterfaceDeclaration
            | ts.TypeAliasDeclaration
            | ts.VariableStatement
            | ts.ClassDeclaration;

        return (
            declarationNode.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword
            ) ?? false
        );
    }
}
