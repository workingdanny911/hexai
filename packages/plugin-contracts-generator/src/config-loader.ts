import { resolve, dirname, basename, relative } from "path";
import ts from "typescript";

import { ConfigLoadError } from "./errors.js";
import { FileSystem, nodeFileSystem } from "./file-system.js";
import type {
    ContractOutputConfig,
    ContractOutputInclude,
    ContractOutputSelect,
    ContractVisibility,
    ContractMarkerNames,
    DecoratorNames,
    EntryStrategy,
    OutputModuleSpecifiers,
    ResponseNamingConvention,
    TrustedDecoratorSources,
} from "./domain/index.js";
import {
    isEntryStrategy,
    isMessageContractKind,
    isOutputModuleSpecifiers,
    mergeContractMarkerNames,
    mergeDecoratorNames,
} from "./domain/index.js";
import { ContextConfig, type InputContextConfig } from "./context-config.js";

const SUPPORTED_GLOB_PARTS_COUNT = 2;

export interface ContractsConfig {
    readonly configDir: string;
    readonly contexts: readonly ContextConfig[];
    readonly outputs?: readonly ContractOutputConfig[];
    readonly pathAliasRewrites?: Readonly<Record<string, string>>;
    readonly externalDependencies?: Readonly<Record<string, string>>;
    readonly decoratorNames: Required<DecoratorNames>;
    readonly contractMarkerNames: Required<ContractMarkerNames>;
    readonly trustedDecoratorSources?: TrustedDecoratorSources;
    readonly entryStrategy?: EntryStrategy;
    readonly outputModuleSpecifiers: OutputModuleSpecifiers;
    readonly responseNamingConventions?: readonly ResponseNamingConvention[];
    readonly removeDecorators?: boolean;
}

interface ApplicationConfig {
    contracts?: {
        contexts?: readonly (string | InputContextConfig)[];
        outputs?: readonly ContractOutputConfig[];
        pathAliasRewrites?: Record<string, string>;
        externalDependencies?: Record<string, string>;
        decoratorNames?: DecoratorNames;
        contractMarkerNames?: ContractMarkerNames;
        trustedDecoratorSources?: TrustedDecoratorSources;
        entryStrategy?: EntryStrategy;
        outputModuleSpecifiers?: OutputModuleSpecifiers;
        responseNamingConventions?: ResponseNamingConvention[];
        removeDecorators?: boolean;
    };
}

export interface ConfigLoaderOptions {
    fileSystem?: FileSystem;
}

export function validateEntryStrategy(
    entryStrategy: EntryStrategy | undefined
): EntryStrategy | undefined {
    if (entryStrategy === undefined) {
        return undefined;
    }

    if (isEntryStrategy(entryStrategy)) {
        return entryStrategy;
    }

    throw new ConfigLoadError(
        `Invalid contracts.entryStrategy: "${String(entryStrategy)}". Expected "graph" or "symbols".`
    );
}

export function validateOutputModuleSpecifiers(
    outputModuleSpecifiers: OutputModuleSpecifiers | undefined,
    path = "contracts.outputModuleSpecifiers"
): OutputModuleSpecifiers {
    if (outputModuleSpecifiers === undefined) {
        return "js";
    }

    if (isOutputModuleSpecifiers(outputModuleSpecifiers)) {
        return outputModuleSpecifiers;
    }

    throw new ConfigLoadError(
        `Invalid ${path}: "${String(outputModuleSpecifiers)}". Expected "js" or "extensionless".`
    );
}

export function validateContractOutputs(
    outputs: readonly ContractOutputConfig[] | undefined
): readonly ContractOutputConfig[] | undefined {
    if (outputs === undefined) {
        return undefined;
    }

    if (!Array.isArray(outputs)) {
        throw new ConfigLoadError("Invalid contracts.outputs: expected an array");
    }

    if (outputs.length === 0) {
        throw new ConfigLoadError("Invalid contracts.outputs: expected at least one output");
    }

    const names = new Set<string>();
    return outputs.map((output, index) => {
        if (!output.name || typeof output.name !== "string") {
            throw new ConfigLoadError(
                `Invalid contracts.outputs[${index}]: missing 'name'`
            );
        }

        if (names.has(output.name)) {
            throw new ConfigLoadError(
                `Invalid contracts.outputs[${index}]: duplicate name "${output.name}"`
            );
        }
        names.add(output.name);

        if (!output.path || typeof output.path !== "string") {
            throw new ConfigLoadError(
                `Invalid contracts.outputs[${index}]: missing 'path'`
            );
        }

        if (
            output.registry !== undefined &&
            typeof output.registry !== "boolean"
        ) {
            throw new ConfigLoadError(
                `Invalid contracts.outputs[${index}].registry: expected boolean`
            );
        }

        return {
            name: output.name,
            path: output.path,
            select: validateOutputSelect(output.select, index),
            registry: output.registry,
            ...(output.outputModuleSpecifiers === undefined
                ? {}
                : {
                    outputModuleSpecifiers: validateOutputModuleSpecifiers(
                        output.outputModuleSpecifiers,
                        `contracts.outputs[${index}].outputModuleSpecifiers`
                    ),
                }),
        };
    });
}

export function validateTrustedDecoratorSources(
    sources: TrustedDecoratorSources | undefined
): TrustedDecoratorSources | undefined {
    if (sources === undefined) {
        return undefined;
    }

    if (!Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
        throw new ConfigLoadError(
            "Invalid contracts.trustedDecoratorSources: expected string array"
        );
    }

    return sources;
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
        const contractMarkerNames = mergeContractMarkerNames(
            contracts.contractMarkerNames
        );
        const entryStrategy = validateEntryStrategy(
            contracts.entryStrategy
        );

        return {
            configDir,
            contexts,
            outputs: validateContractOutputs(contracts.outputs),
            pathAliasRewrites: contracts.pathAliasRewrites,
            externalDependencies: contracts.externalDependencies,
            decoratorNames,
            contractMarkerNames,
            trustedDecoratorSources: validateTrustedDecoratorSources(
                contracts.trustedDecoratorSources
            ),
            entryStrategy,
            outputModuleSpecifiers: validateOutputModuleSpecifiers(
                contracts.outputModuleSpecifiers
            ),
            responseNamingConventions: contracts.responseNamingConventions,
            removeDecorators: contracts.removeDecorators ?? true,
        };
    }
}

export { ConfigLoadError } from "./errors.js";

function isContractVisibility(value: string): value is ContractVisibility {
    return value === "public" || value === "internal";
}

function validateOutputSelect(
    select: ContractOutputSelect | undefined,
    outputIndex: number
): ContractOutputSelect | undefined {
    if (select === undefined) {
        return undefined;
    }

    if (typeof select !== "object" || select === null || Array.isArray(select)) {
        throw new ConfigLoadError(
            `Invalid contracts.outputs[${outputIndex}].select: expected object`
        );
    }

    return {
        visibility: validateStringArray(
            select.visibility,
            `contracts.outputs[${outputIndex}].select.visibility`,
            isContractVisibility,
            '"public" or "internal"'
        ),
        kinds: validateStringArray(
            select.kinds,
            `contracts.outputs[${outputIndex}].select.kinds`
        ),
        messageKinds: validateStringArray(
            select.messageKinds,
            `contracts.outputs[${outputIndex}].select.messageKinds`,
            isMessageContractKind,
            '"command", "query", or "event"'
        ),
        include: validateOutputInclude(select.include, outputIndex),
        tags: validateTagsSelect(select.tags, outputIndex),
    };
}

function validateOutputInclude(
    include: ContractOutputInclude | undefined,
    outputIndex: number
): ContractOutputInclude | undefined {
    if (include === undefined) {
        return undefined;
    }

    if (include === "all" || include === "messages" || include === "contracts") {
        return include;
    }

    throw new ConfigLoadError(
        `Invalid contracts.outputs[${outputIndex}].select.include: "${String(include)}". Expected "all", "messages", or "contracts".`
    );
}

function validateTagsSelect(
    tags: ContractOutputSelect["tags"] | undefined,
    outputIndex: number
): ContractOutputSelect["tags"] | undefined {
    if (tags === undefined) {
        return undefined;
    }

    if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
        throw new ConfigLoadError(
            `Invalid contracts.outputs[${outputIndex}].select.tags: expected object`
        );
    }

    return {
        include: validateStringArray(
            tags.include,
            `contracts.outputs[${outputIndex}].select.tags.include`
        ),
        exclude: validateStringArray(
            tags.exclude,
            `contracts.outputs[${outputIndex}].select.tags.exclude`
        ),
    };
}

function validateStringArray<T extends string>(
    value: readonly string[] | undefined,
    path: string,
    guard?: (value: string) => value is T,
    expected?: string
): readonly T[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new ConfigLoadError(`Invalid ${path}: expected string array`);
    }

    const invalid = guard
        ? value.filter((item) => !guard(item))
        : [];

    if (invalid.length > 0) {
        throw new ConfigLoadError(
            `Invalid ${path}: ${invalid.map((item) => `"${item}"`).join(", ")}. Expected ${expected}.`
        );
    }

    return value as readonly T[];
}
