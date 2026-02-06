import { resolve, dirname, basename, relative } from "path";
import ts from "typescript";

import { ConfigLoadError } from "./errors";
import { FileSystem, nodeFileSystem } from "./file-system";
import type { DecoratorNames, ResponseNamingConvention } from "./domain";
import { mergeDecoratorNames } from "./domain";
import { ContextConfig, type InputContextConfig } from "./context-config";

const SUPPORTED_GLOB_PARTS_COUNT = 2;

export interface ContractsConfig {
    readonly contexts: readonly ContextConfig[];
    readonly pathAliasRewrites?: Readonly<Record<string, string>>;
    readonly externalDependencies?: Readonly<Record<string, string>>;
    readonly decoratorNames: Required<DecoratorNames>;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];
    readonly removeDecorators?: boolean;
}

interface ApplicationConfig {
    contracts?: {
        contexts?: readonly (string | InputContextConfig)[];
        pathAliasRewrites?: Record<string, string>;
        externalDependencies?: Record<string, string>;
        decoratorNames?: DecoratorNames;
        responseNamingConventions?: ResponseNamingConvention[];
        removeDecorators?: boolean;
    };
}

export interface ConfigLoaderOptions {
    fileSystem?: FileSystem;
}

export async function resolveContextEntries(
    entries: readonly (string | InputContextConfig)[],
    configDir: string,
    fs: FileSystem = nodeFileSystem
): Promise<ContextConfig[]> {
    const contexts: ContextConfig[] = [];

    for (let i = 0; i < entries.length; i++) {
        const item = entries[i];

        if (typeof item === "string") {
            const resolved = await resolveStringEntry(item, configDir, fs);
            contexts.push(...resolved);
        } else {
            const contextConfig = await createObjectContext(item, i, configDir, fs);
            contexts.push(contextConfig);
        }
    }

    return contexts;
}

async function resolveStringEntry(
    contextPath: string,
    configDir: string,
    fs: FileSystem
): Promise<ContextConfig[]> {
    if (contextPath.includes("*")) {
        return expandGlobPattern(contextPath, configDir, fs);
    }

    const basePath = resolve(configDir, contextPath);
    const name = basename(basePath);

    return [await ContextConfig.create(
        { name, path: contextPath },
        configDir,
        fs
    )];
}

async function expandGlobPattern(
    pattern: string,
    configDir: string,
    fs: FileSystem
): Promise<ContextConfig[]> {
    const packageDirs = await matchGlobPattern(pattern, configDir, fs);

    return Promise.all(
        packageDirs.map((dir) => {
            const name = basename(dir);
            const relativePath = relative(configDir, dir);

            return ContextConfig.create(
                { name, path: relativePath },
                configDir,
                fs
            );
        })
    );
}

async function createObjectContext(
    ctx: InputContextConfig,
    index: number,
    configDir: string,
    fs: FileSystem
): Promise<ContextConfig> {
    if (!ctx.name || typeof ctx.name !== "string") {
        throw new ConfigLoadError(
            `Invalid context at index ${index}: missing 'name'`
        );
    }
    if (!ctx.path || typeof ctx.path !== "string") {
        throw new ConfigLoadError(
            `Invalid context at index ${index}: missing 'path'`
        );
    }

    return ContextConfig.create(ctx, configDir, fs);
}

async function matchGlobPattern(
    pattern: string,
    configDir: string,
    fs: FileSystem
): Promise<string[]> {
    const globParts = pattern.split("*");

    if (globParts.length !== SUPPORTED_GLOB_PARTS_COUNT) {
        throw new ConfigLoadError(
            `Invalid glob pattern: "${pattern}". Only single wildcard patterns like "packages/*" are supported.`
        );
    }

    const [prefix, suffix] = globParts;
    const baseDir = resolve(configDir, prefix);

    if (!await fs.exists(baseDir)) {
        return [];
    }

    const entries = await fs.readdir(baseDir);
    const matchedDirs: string[] = [];

    for (const entry of entries) {
        const fullPath = resolve(baseDir, entry);
        const stats = await fs.stat(fullPath);

        if (!stats.isDirectory()) {
            continue;
        }

        if (suffix) {
            const suffixPath = resolve(fullPath, suffix.replace(/^\//, ""));
            if (await fs.exists(suffixPath)) {
                matchedDirs.push(fullPath);
            }
        } else {
            matchedDirs.push(fullPath);
        }
    }

    return matchedDirs.sort();
}

export class ConfigLoader {
    private readonly fs: FileSystem;

    constructor(options: ConfigLoaderOptions = {}) {
        this.fs = options.fileSystem ?? nodeFileSystem;
    }

    async load(configPath: string): Promise<ContractsConfig> {
        const absolutePath = resolve(configPath);
        const config = await this.loadTypeScriptConfig(absolutePath);

        return this.extractContractsConfig(config, dirname(absolutePath));
    }

    private async loadTypeScriptConfig(absolutePath: string): Promise<ApplicationConfig> {
        const source = await this.fs.readFile(absolutePath);
        const result = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
            },
        });

        const exports: { default?: ApplicationConfig } = {};
        const moduleWrapper = new Function("exports", result.outputText);
        moduleWrapper(exports);

        return exports.default ?? (exports as unknown as ApplicationConfig);
    }

    private async extractContractsConfig(
        config: ApplicationConfig,
        configDir: string
    ): Promise<ContractsConfig> {
        const contracts = config.contracts;

        if (!contracts) {
            throw new ConfigLoadError("Missing 'contracts' section in config");
        }

        if (!contracts.contexts || !Array.isArray(contracts.contexts)) {
            throw new ConfigLoadError("Missing 'contracts.contexts' in config");
        }

        const contexts = await resolveContextEntries(contracts.contexts, configDir, this.fs);

        if (contexts.length === 0) {
            throw new ConfigLoadError("No contexts found from 'contexts'");
        }

        const decoratorNames = mergeDecoratorNames(contracts.decoratorNames);

        return {
            contexts,
            pathAliasRewrites: contracts.pathAliasRewrites,
            externalDependencies: contracts.externalDependencies,
            decoratorNames,
            responseNamingConventions: contracts.responseNamingConventions,
            removeDecorators: contracts.removeDecorators ?? true,
        };
    }
}

export { ConfigLoadError } from "./errors";
