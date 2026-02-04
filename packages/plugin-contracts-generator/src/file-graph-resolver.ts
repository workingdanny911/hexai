import ts from "typescript";
import path from "path";
import { minimatch } from "minimatch";

import { extractImportedNames } from "./import-analyzer";
import { ContextConfig } from "./context-config";
import { FileReadError } from "./errors";
import { FileSystem, nodeFileSystem } from "./file-system";

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx"];
const INDEX_FILE = "index.ts";

export interface ImportInfo {
    moduleSpecifier: string;
    resolvedPath: string | null;
    isExternal: boolean;
    importedNames: string[];
}

export interface FileNode {
    absolutePath: string;
    relativePath: string;
    imports: ImportInfo[];
    isEntryPoint: boolean;
}

export interface FileGraph {
    nodes: Map<string, FileNode>;
    entryPoints: Set<string>;
    excludedPaths: Set<string>;
}

export interface FileGraphResolverOptions {
    contextConfig: ContextConfig;
    fileSystem?: FileSystem;
    excludeDependencies?: string[];
}

export class FileGraphResolver {
    private readonly contextConfig: ContextConfig;
    private readonly fs: FileSystem;
    private readonly excludeDependencies: string[];

    private constructor(
        contextConfig: ContextConfig,
        fileSystem: FileSystem,
        excludeDependencies: string[]
    ) {
        this.contextConfig = contextConfig;
        this.fs = fileSystem;
        this.excludeDependencies = excludeDependencies;
    }

    static create(options: FileGraphResolverOptions): FileGraphResolver {
        const fs = options.fileSystem ?? nodeFileSystem;
        const excludeDependencies = options.excludeDependencies ?? [];
        return new FileGraphResolver(options.contextConfig, fs, excludeDependencies);
    }

    async buildGraph(entryPoints: string[], sourceRoot: string): Promise<FileGraph> {
        const nodes = new Map<string, FileNode>();
        const entryPointSet = new Set<string>(entryPoints);
        const excludedPaths = new Set<string>();
        const visited = new Set<string>();
        const queue = [...entryPoints];

        while (queue.length > 0) {
            const filePath = queue.shift()!;

            if (visited.has(filePath)) {
                continue;
            }
            visited.add(filePath);

            const imports = await this.extractImports(filePath);

            const node: FileNode = {
                absolutePath: filePath,
                relativePath: path.relative(sourceRoot, filePath),
                imports,
                isEntryPoint: entryPointSet.has(filePath),
            };
            nodes.set(filePath, node);

            this.queueUnvisitedLocalDependencies(imports, visited, queue, excludedPaths);
        }

        return {
            nodes,
            entryPoints: entryPointSet,
            excludedPaths,
        };
    }

    private async extractImports(filePath: string): Promise<ImportInfo[]> {
        const sourceCode = await this.readSourceFile(filePath);
        const sourceFile = ts.createSourceFile(
            filePath,
            sourceCode,
            ts.ScriptTarget.Latest,
            true
        );

        const imports: ImportInfo[] = [];

        for (const node of sourceFile.statements) {
            const moduleSpecifier = this.extractModuleSpecifier(node);
            if (!moduleSpecifier) {
                continue;
            }

            const resolution = await this.resolveModule(moduleSpecifier, filePath);

            const importedNames = this.extractImportedNamesFromNode(node);

            imports.push({
                moduleSpecifier,
                resolvedPath: resolution.resolvedPath,
                isExternal: resolution.isExternal,
                importedNames,
            });
        }

        return imports;
    }

    private async readSourceFile(filePath: string): Promise<string> {
        try {
            return await this.fs.readFile(filePath);
        } catch (error) {
            throw new FileReadError(filePath, { cause: error });
        }
    }

    private extractModuleSpecifier(node: ts.Statement): string | null {
        if (ts.isImportDeclaration(node)) {
            return (node.moduleSpecifier as ts.StringLiteral).text;
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            return (node.moduleSpecifier as ts.StringLiteral).text;
        }
        return null;
    }

    private extractImportedNamesFromNode(node: ts.Statement): string[] {
        if (ts.isImportDeclaration(node) && node.importClause) {
            return extractImportedNames(node.importClause);
        }
        // Re-exports don't have named imports in the traditional sense
        return [];
    }

    private async resolveModule(
        moduleSpecifier: string,
        fromFile: string
    ): Promise<{ resolvedPath: string | null; isExternal: boolean }> {
        if (moduleSpecifier.startsWith(".")) {
            const resolvedPath = await this.resolveRelativeModule(
                moduleSpecifier,
                fromFile
            );
            return { resolvedPath, isExternal: false };
        }

        return this.contextConfig.resolvePath(moduleSpecifier);
    }

    private queueUnvisitedLocalDependencies(
        imports: ImportInfo[],
        visited: Set<string>,
        queue: string[],
        excludedPaths: Set<string>
    ): void {
        const localImports = imports.filter(
            (importInfo) => !importInfo.isExternal && importInfo.resolvedPath !== null
        );

        for (const importInfo of localImports) {
            const resolvedPath = importInfo.resolvedPath!;

            if (this.shouldExclude(resolvedPath)) {
                excludedPaths.add(resolvedPath);
                continue;
            }

            if (!visited.has(resolvedPath)) {
                queue.push(resolvedPath);
            }
        }
    }

    private shouldExclude(filePath: string): boolean {
        if (this.excludeDependencies.length === 0) {
            return false;
        }
        return this.excludeDependencies.some((pattern) =>
            minimatch(filePath, pattern, { matchBase: true })
        );
    }

    private async resolveRelativeModule(
        moduleSpecifier: string,
        fromFile: string
    ): Promise<string | null> {
        const dir = path.dirname(fromFile);
        const basePath = path.resolve(dir, moduleSpecifier);

        return this.tryResolveWithExtensions(basePath);
    }

    private async tryResolveWithExtensions(basePath: string): Promise<string | null> {
        const extensionCandidates = TYPESCRIPT_EXTENSIONS.map(ext => basePath + ext);
        const indexCandidate = path.join(basePath, INDEX_FILE);
        const candidates = [...extensionCandidates, indexCandidate];

        for (const candidate of candidates) {
            if (await this.fs.exists(candidate)) {
                return candidate;
            }
        }

        return null;
    }
}
