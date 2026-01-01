import * as ts from "typescript";
import * as path from "path";
import { minimatch } from "minimatch";

import { extractImportedNames } from "./import-analyzer";
import { TsconfigLoader, PathAliasConfig } from "./tsconfig-loader";
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
    tsconfigPath?: string;
    pathAliasConfig?: PathAliasConfig;
    fileSystem?: FileSystem;
    excludeDependencies?: string[];
}

export class FileGraphResolver {
    private readonly pathAliasConfig: PathAliasConfig | null;
    private readonly fs: FileSystem;
    private readonly excludeDependencies: string[];

    private constructor(
        pathAliasConfig: PathAliasConfig | null,
        fileSystem: FileSystem,
        excludeDependencies: string[]
    ) {
        this.pathAliasConfig = pathAliasConfig;
        this.fs = fileSystem;
        this.excludeDependencies = excludeDependencies;
    }

    static async create(options?: FileGraphResolverOptions): Promise<FileGraphResolver> {
        const fs = options?.fileSystem ?? nodeFileSystem;
        const pathAliasConfig = await FileGraphResolver.loadPathAliasConfig(options, fs);
        const excludeDependencies = options?.excludeDependencies ?? [];
        return new FileGraphResolver(pathAliasConfig, fs, excludeDependencies);
    }

    private static async loadPathAliasConfig(
        options: FileGraphResolverOptions | undefined,
        fileSystem: FileSystem
    ): Promise<PathAliasConfig | null> {
        if (options?.pathAliasConfig) {
            return options.pathAliasConfig;
        }
        if (options?.tsconfigPath) {
            const loader = new TsconfigLoader();
            return loader.load(options.tsconfigPath);
        }
        return null;
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

            const imports = await this.extractImports(filePath, sourceRoot);

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

    private async extractImports(filePath: string, sourceRoot: string): Promise<ImportInfo[]> {
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

            const resolution = await this.resolveModule(
                moduleSpecifier,
                filePath,
                sourceRoot
            );

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
        fromFile: string,
        sourceRoot: string
    ): Promise<{ resolvedPath: string | null; isExternal: boolean }> {
        if (moduleSpecifier.startsWith(".")) {
            const resolvedPath = await this.resolveRelativeModule(
                moduleSpecifier,
                fromFile
            );
            return { resolvedPath, isExternal: false };
        }

        const pathAliasResolved = await this.resolvePathAlias(
            moduleSpecifier,
            sourceRoot
        );
        if (pathAliasResolved) {
            return { resolvedPath: pathAliasResolved, isExternal: false };
        }

        return { resolvedPath: null, isExternal: true };
    }

    private async resolvePathAlias(
        moduleSpecifier: string,
        sourceRoot: string
    ): Promise<string | null> {
        if (!this.pathAliasConfig) {
            return null;
        }

        for (const [pattern, targets] of this.pathAliasConfig.paths) {
            const wildcardMatch = this.matchPathPattern(moduleSpecifier, pattern);
            if (wildcardMatch === null) {
                continue;
            }

            const resolvedPath = await this.resolveFirstMatchingTarget(
                targets,
                wildcardMatch,
                sourceRoot
            );
            if (resolvedPath) {
                return resolvedPath;
            }
        }

        return null;
    }

    private async resolveFirstMatchingTarget(
        targets: string[],
        wildcardMatch: string,
        sourceRoot: string
    ): Promise<string | null> {
        for (const target of targets) {
            const resolvedTarget = target.replace("*", wildcardMatch);
            const resolvedPath = await this.tryResolveWithExtensions(resolvedTarget);

            const isWithinSourceRoot = resolvedPath?.startsWith(sourceRoot);
            if (isWithinSourceRoot) {
                return resolvedPath;
            }
        }
        return null;
    }

    private matchPathPattern(
        moduleSpecifier: string,
        pattern: string
    ): string | null {
        if (pattern.endsWith("*")) {
            const prefix = pattern.slice(0, -1);
            if (moduleSpecifier.startsWith(prefix)) {
                return moduleSpecifier.slice(prefix.length);
            }
        } else if (moduleSpecifier === pattern) {
            return "";
        }
        return null;
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
