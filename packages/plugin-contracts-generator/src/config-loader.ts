import { resolve, dirname, join } from "path";
import * as ts from "typescript";

import { ConfigLoadError } from "./errors";
import { FileSystem, nodeFileSystem } from "./file-system";
import type { DecoratorNames, ResponseNamingConvention } from "./domain";
import { mergeDecoratorNames } from "./domain";

const PACKAGE_CONFIG_FILENAME = "application.config.ts";
const SUPPORTED_GLOB_PARTS_COUNT = 2;

export interface ContextConfig {
    readonly name: string;
    readonly sourceDir: string;
    readonly tsconfigPath?: string;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];
}

export interface ContractsConfig {
    readonly contexts: readonly ContextConfig[];
    readonly pathAliasRewrites?: Readonly<Record<string, string>>;
    readonly externalDependencies?: Readonly<Record<string, string>>;
    readonly decoratorNames: Required<DecoratorNames>;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];
    readonly removeDecorators?: boolean;
}

interface PackageConfig {
    contextName?: string;
    sourceDir?: string;
    tsconfigPath?: string;
    responseNamingConventions?: readonly ResponseNamingConvention[];
}

interface ApplicationConfig {
    contracts?: {
        contexts?: string[] | Array<{
            name?: string;
            sourceDir?: string;
            tsconfigPath?: string;
        }>;
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

        const contexts = await this.resolveContexts(contracts.contexts, configDir);

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

    private async resolveContexts(
        contextsConfig: string[] | Array<{ name?: string; sourceDir?: string; tsconfigPath?: string }>,
        configDir: string
    ): Promise<ContextConfig[]> {
        const contexts: ContextConfig[] = [];

        for (let i = 0; i < contextsConfig.length; i++) {
            const item = contextsConfig[i];

            if (typeof item === "string") {
                const resolvedContexts = await this.resolveStringContext(item, configDir);
                contexts.push(...resolvedContexts);
            } else {
                const validated = this.validateObjectContext(item, i);
                contexts.push(validated);
            }
        }

        return contexts;
    }

    private async resolveStringContext(
        contextPath: string,
        configDir: string
    ): Promise<ContextConfig[]> {
        if (contextPath.includes("*")) {
            return this.expandGlobPattern(contextPath, configDir);
        }

        const packageDir = resolve(configDir, contextPath);
        return [await this.loadPackageConfig(packageDir)];
    }

    private async expandGlobPattern(pattern: string, configDir: string): Promise<ContextConfig[]> {
        const packageDirs = await this.matchGlobPattern(pattern, configDir);
        const configs = await Promise.all(
            packageDirs.map((packageDir) => this.loadPackageConfig(packageDir))
        );
        return configs;
    }

    private async loadPackageConfig(packageDir: string): Promise<ContextConfig> {
        const configPath = join(packageDir, PACKAGE_CONFIG_FILENAME);

        if (!await this.fs.exists(configPath)) {
            throw new ConfigLoadError(
                `Missing application.config.ts in package: ${packageDir}`
            );
        }

        const packageConfig = await this.loadTypeScriptConfig(configPath) as PackageConfig;

        if (!packageConfig.contextName || typeof packageConfig.contextName !== "string") {
            throw new ConfigLoadError(
                `Missing 'contextName' in ${configPath}`
            );
        }

        if (!packageConfig.sourceDir || typeof packageConfig.sourceDir !== "string") {
            throw new ConfigLoadError(
                `Missing 'sourceDir' in ${configPath}`
            );
        }

        const contextName = packageConfig.contextName;
        const sourceDir = resolve(packageDir, packageConfig.sourceDir);
        const tsconfigPath = packageConfig.tsconfigPath
            ? resolve(packageDir, packageConfig.tsconfigPath)
            : undefined;

        return {
            name: contextName,
            sourceDir,
            tsconfigPath,
            responseNamingConventions: packageConfig.responseNamingConventions,
        };
    }

    private validateObjectContext(
        ctx: {
            name?: string;
            sourceDir?: string;
            tsconfigPath?: string;
        },
        index: number
    ): ContextConfig {
        if (!ctx.name || typeof ctx.name !== "string") {
            throw new ConfigLoadError(
                `Invalid context at index ${index}: missing 'name'`
            );
        }
        if (!ctx.sourceDir || typeof ctx.sourceDir !== "string") {
            throw new ConfigLoadError(
                `Invalid context at index ${index}: missing 'sourceDir'`
            );
        }

        return {
            name: ctx.name,
            sourceDir: ctx.sourceDir,
            tsconfigPath: ctx.tsconfigPath,
        };
    }

    private async matchGlobPattern(pattern: string, configDir: string): Promise<string[]> {
        const globParts = pattern.split("*");

        if (globParts.length !== SUPPORTED_GLOB_PARTS_COUNT) {
            throw new ConfigLoadError(
                `Invalid glob pattern: "${pattern}". Only single wildcard patterns like "packages/*" are supported.`
            );
        }

        const [prefix, suffix] = globParts;
        const baseDir = resolve(configDir, prefix);

        if (!await this.fs.exists(baseDir)) {
            return [];
        }

        const entries = await this.fs.readdir(baseDir);
        const matchedDirs: string[] = [];

        for (const entry of entries) {
            const fullPath = resolve(baseDir, entry);
            const stats = await this.fs.stat(fullPath);

            if (!stats.isDirectory()) {
                continue;
            }

            if (suffix) {
                const suffixPath = resolve(fullPath, suffix.replace(/^\//, ""));
                if (await this.fs.exists(suffixPath)) {
                    matchedDirs.push(fullPath);
                }
            } else {
                matchedDirs.push(fullPath);
            }
        }

        return matchedDirs.sort();
    }
}

export { ConfigLoadError } from "./errors";
