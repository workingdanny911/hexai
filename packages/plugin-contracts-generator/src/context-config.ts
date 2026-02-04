import path from "path";
import ts from "typescript";

import type { FileSystem } from "./file-system";
import { nodeFileSystem } from "./file-system";
import type { ResponseNamingConvention } from "./domain/types";

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".d.ts"];
const INDEX_FILE = "index.ts";

/**
 * Internal class for handling tsconfig path alias resolution.
 * Uses Null Object pattern - NONE instance handles missing tsconfig case.
 */
class Tsconfig {
    static readonly NONE = new Tsconfig(new Map());

    private constructor(private readonly paths: Map<string, string[]>) {}

    static async load(tsconfigPath: string, fs: FileSystem): Promise<Tsconfig> {
        const absolutePath = path.resolve(tsconfigPath);
        const configDir = path.dirname(absolutePath);

        const content = await fs.readFile(absolutePath);
        const { config, error } = ts.parseConfigFileTextToJson(absolutePath, content);

        if (error) {
            throw new Error(
                `Failed to parse tsconfig: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`
            );
        }

        const parsed = ts.parseJsonConfigFileContent(config, ts.sys, configDir);

        const baseUrl = parsed.options.baseUrl ?? configDir;
        const paths = new Map<string, string[]>();

        if (parsed.options.paths) {
            for (const [alias, targets] of Object.entries(parsed.options.paths)) {
                const resolvedTargets = (targets as string[]).map((target) =>
                    path.join(baseUrl, target)
                );
                paths.set(alias, resolvedTargets);
            }
        }

        return new Tsconfig(paths);
    }

    /**
     * Pure string transformation: resolves path alias to potential file paths.
     * Returns null if no alias matches.
     */
    resolvePath(importPath: string): string[] | null {
        for (const [pattern, targets] of this.paths) {
            const wildcardMatch = this.matchPathPattern(importPath, pattern);
            if (wildcardMatch === null) {
                continue;
            }

            return targets.map((target) => target.replace("*", wildcardMatch));
        }

        return null;
    }

    private matchPathPattern(moduleSpecifier: string, pattern: string): string | null {
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
}

export interface InputContextConfig {
    readonly name: string;
    readonly path: string;
    readonly sourceDir?: string;
    readonly tsconfigPath?: string;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];
}

/**
 * Encapsulates context configuration with path resolution capabilities.
 * Created via factory method to ensure proper initialization.
 */
export class ContextConfig {
    private readonly fs: FileSystem;
    private readonly tsconfig: Tsconfig;

    readonly name: string;
    readonly sourceDir: string;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];

    private constructor(
        name: string,
        sourceDir: string,
        tsconfig: Tsconfig,
        fs: FileSystem,
        responseNamingConventions?: readonly ResponseNamingConvention[]
    ) {
        this.name = name;
        this.sourceDir = sourceDir;
        this.tsconfig = tsconfig;
        this.fs = fs;
        this.responseNamingConventions = responseNamingConventions;
    }

    /**
     * Factory method to create ContextConfig with properly loaded tsconfig.
     */
    static async create(
        input: InputContextConfig,
        configDir: string,
        fs: FileSystem = nodeFileSystem
    ): Promise<ContextConfig> {
        if (!input.name) {
            throw new Error("ContextConfig requires 'name'");
        }
        if (!input.path) {
            throw new Error(`ContextConfig '${input.name}' requires 'path'`);
        }

        const basePath = path.resolve(configDir, input.path);
        const sourceDir = path.resolve(basePath, input.sourceDir ?? "src");
        const tsconfig = await this.loadTsconfig(basePath, input.tsconfigPath, fs);

        return new ContextConfig(
            input.name,
            sourceDir,
            tsconfig,
            fs,
            input.responseNamingConventions
        );
    }

    private static async loadTsconfig(
        basePath: string,
        inputPath: string | undefined,
        fs: FileSystem
    ): Promise<Tsconfig> {
        const tsconfigPath = path.resolve(basePath, inputPath ?? "tsconfig.json");
        if (!await fs.exists(tsconfigPath)) {
            return Tsconfig.NONE;
        }
        return Tsconfig.load(tsconfigPath, fs);
    }

    /**
     * Creates a ContextConfig without async loading (for cases where tsconfig is not needed
     * or already handled externally).
     */
    static createSync(
        name: string,
        sourceDir: string,
        fs: FileSystem = nodeFileSystem,
        responseNamingConventions?: readonly ResponseNamingConvention[]
    ): ContextConfig {
        return new ContextConfig(
            name,
            sourceDir,
            Tsconfig.NONE,
            fs,
            responseNamingConventions
        );
    }

    /**
     * Resolves a module specifier (path alias) to actual file path.
     * Only handles non-relative imports (path aliases).
     *
     * @param moduleSpecifier - The import path to resolve (e.g., "@/utils/helper")
     * @returns Object with resolvedPath (null if external) and isExternal flag
     */
    async resolvePath(
        moduleSpecifier: string
    ): Promise<{ resolvedPath: string | null; isExternal: boolean }> {
        const resolvedPaths = this.tsconfig.resolvePath(moduleSpecifier);
        if (!resolvedPaths) {
            return { resolvedPath: null, isExternal: true };
        }

        for (const resolvedPath of resolvedPaths) {
            const filePath = await this.tryResolveWithExtensions(resolvedPath);
            if (filePath && filePath.startsWith(this.sourceDir)) {
                return { resolvedPath: filePath, isExternal: false };
            }
        }

        return { resolvedPath: null, isExternal: true };
    }

    private async tryResolveWithExtensions(basePath: string): Promise<string | null> {
        const extensionCandidates = TYPESCRIPT_EXTENSIONS.map((ext) => basePath + ext);
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
