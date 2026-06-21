#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join, relative } from "node:path";
import {
    ConfigLoader,
    type ContractsConfig,
    resolveContextEntries,
    validateContractOutputs,
    validateDependencyStrategy,
    validateOutputModuleSpecifiers,
    validateTrustedDecoratorSources,
} from "./config-loader.js";
import type { InputContextConfig } from "./context-config.js";
import { ContractsPipeline, type PipelineResult, ConsoleLogger, type Logger } from "./index.js";
import { RegistryGenerator, ContextMessages } from "./registry-generator.js";
import { ReexportGenerator } from "./reexport-generator.js";
import { nodeFileSystem } from "./file-system.js";
import { formatRelativeIndexSpecifier } from "./module-specifier.js";
import type {
    ContractMarkerNames,
    ContractOutputConfig,
    ContractOutputSelect,
    DecoratorNames,
    DependencyStrategy,
    MessageType,
    OutputModuleSpecifiers,
    ResponseNamingConvention,
    TrustedDecoratorSources,
} from "./domain/types.js";
import {
    mergeContractMarkerNames,
    mergeDecoratorNames,
} from "./domain/index.js";

const DEFAULT_CONFIG_PATH = "application.config.ts";
const EXIT_CODE_ERROR = 1;
const VALID_MESSAGE_TYPES: readonly MessageType[] = ["event", "command", "query"];
const VALID_INCLUDE_MODES: readonly IncludeMode[] = [
    "all",
    "messages",
    "contracts",
];
const CHECK_DIFF_LIST_LIMIT = 20;

export type IncludeMode = "all" | "messages" | "contracts";

const CLI_OPTIONS = {
    config: { short: "-c", long: "--config", requiresValue: true },
    outputDir: { short: "-o", long: "--output-dir", requiresValue: true },
    include: { short: null, long: "--include", requiresValue: true },
    messages: { short: null, long: "--messages", requiresValue: true },
    messageTypes: { short: "-m", long: "--message-types", requiresValue: true },
    dependencyStrategy: {
        short: null,
        long: "--dependency-strategy",
        requiresValue: true,
    },
    outputModuleSpecifiers: {
        short: null,
        long: "--output-module-specifiers",
        requiresValue: true,
    },
    registry: { short: null, long: "--registry", requiresValue: false },
    generateMessageRegistry: { short: null, long: "--generate-message-registry", requiresValue: false },
    dryRun: { short: null, long: "--dry-run", requiresValue: false },
    check: { short: null, long: "--check", requiresValue: false },
    help: { short: "-h", long: "--help", requiresValue: false },
} as const;

interface CliOptions {
    config: string;
    outputDir?: string;
    include?: IncludeMode;
    messageTypes?: MessageType[];
    dependencyStrategy?: DependencyStrategy;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
    generateMessageRegistry?: boolean;
    dryRun?: boolean;
    check?: boolean;
}

/**
 * Options for runWithConfig when config is provided directly.
 */
export interface RunWithConfigOptions {
    outputDir?: string;
    include?: IncludeMode;
    messageTypes?: MessageType[];
    dependencyStrategy?: DependencyStrategy;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
    generateMessageRegistry?: boolean;
    dryRun?: boolean;
    check?: boolean;
}

/**
 * Plugin configuration structure for contracts generator.
 * This is the config passed from hexai.config.ts.
 */
export interface ContractsPluginConfig {
    contexts: Array<string | InputContextConfig>;
    outputs?: readonly ContractOutputConfig[];
    pathAliasRewrites?: Record<string, string>;
    externalDependencies?: Record<string, string>;
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    trustedDecoratorSources?: TrustedDecoratorSources;
    dependencyStrategy?: DependencyStrategy;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
    responseNamingConventions?: ResponseNamingConvention[];
    removeDecorators?: boolean;
}

interface ContextProcessingResult {
    name: string;
    result: PipelineResult;
    outputDir: string;
}

interface OutputPlan {
    name: string;
    outputDir: string;
    select?: ContractOutputSelect;
    generateMessageRegistry: boolean;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
}

interface GenerationScope {
    messageTypes?: MessageType[];
    includePublicContracts: boolean;
}

function parseMessageTypes(value: string): MessageType[] {
    const types = value.split(",").map((type) => type.trim().toLowerCase());
    const invalidTypes = types.filter((type) => !VALID_MESSAGE_TYPES.includes(type as MessageType));

    if (invalidTypes.length > 0) {
        throw new Error(
            `Invalid message type(s): ${invalidTypes.join(", ")}. ` +
            `Valid types are: ${VALID_MESSAGE_TYPES.join(", ")}`
        );
    }

    return types as MessageType[];
}

function parseIncludeMode(value: string): IncludeMode {
    const mode = value.trim().toLowerCase();
    if (!VALID_INCLUDE_MODES.includes(mode as IncludeMode)) {
        throw new Error(
            `Invalid include mode: ${value}. ` +
            `Valid modes are: ${VALID_INCLUDE_MODES.join(", ")}`
        );
    }

    return mode as IncludeMode;
}

function parseDependencyStrategy(value: string): DependencyStrategy {
    return validateDependencyStrategy(
        value.trim().toLowerCase() as DependencyStrategy,
        "--dependency-strategy"
    );
}

function parseOutputModuleSpecifiers(value: string): OutputModuleSpecifiers {
    return validateOutputModuleSpecifiers(
        value.trim().toLowerCase() as OutputModuleSpecifiers,
        "--output-module-specifiers"
    );
}

function resolveGenerationScope(options: {
    include?: IncludeMode;
    messageTypes?: MessageType[];
}): GenerationScope {
    const include = options.include ?? "all";

    if (include === "contracts") {
        return {
            messageTypes: [],
            includePublicContracts: true,
        };
    }

    if (include === "messages") {
        return {
            messageTypes: options.messageTypes ?? [...VALID_MESSAGE_TYPES],
            includePublicContracts: false,
        };
    }

    return {
        messageTypes: options.messageTypes,
        includePublicContracts: true,
    };
}

function extractOptionValue(args: string[], currentIndex: number, optionName: string): { value: string; nextIndex: number } {
    const currentArg = args[currentIndex];

    const equalsIndex = currentArg.indexOf("=");
    if (equalsIndex !== -1) {
        return {
            value: currentArg.slice(equalsIndex + 1),
            nextIndex: currentIndex,
        };
    }

    const nextValue = args[currentIndex + 1];
    if (!nextValue) {
        throw new Error(`Missing value for ${optionName} option`);
    }

    return {
        value: nextValue,
        nextIndex: currentIndex + 1,
    };
}

function matchesOption(arg: string, option: typeof CLI_OPTIONS[keyof typeof CLI_OPTIONS]): boolean {
    const matchesShortOrLong = arg === option.short || arg === option.long;
    const matchesLongWithValue = option.long !== null && arg.startsWith(`${option.long}=`);
    return matchesShortOrLong || matchesLongWithValue;
}

function parseArgs(args: string[]): CliOptions {
    const options: Partial<CliOptions> = {
        config: DEFAULT_CONFIG_PATH,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (matchesOption(arg, CLI_OPTIONS.config)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--config");
            options.config = value;
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.outputDir)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--output-dir");
            options.outputDir = value;
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.include)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--include");
            options.include = parseIncludeMode(value);
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.messages)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--messages");
            options.messageTypes = parseMessageTypes(value);
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.messageTypes)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--message-types");
            options.messageTypes = parseMessageTypes(value);
            i = nextIndex;
        } else if (arg === "--entry-strategy" || arg.startsWith("--entry-strategy=")) {
            throw new Error(
                "--entry-strategy has been removed. Strict symbol entry extraction is always used."
            );
        } else if (matchesOption(arg, CLI_OPTIONS.dependencyStrategy)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--dependency-strategy");
            options.dependencyStrategy = parseDependencyStrategy(value);
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.outputModuleSpecifiers)) {
            const { value, nextIndex } = extractOptionValue(
                args,
                i,
                "--output-module-specifiers"
            );
            options.outputModuleSpecifiers = parseOutputModuleSpecifiers(value);
            i = nextIndex;
        } else if (
            matchesOption(arg, CLI_OPTIONS.registry) ||
            matchesOption(arg, CLI_OPTIONS.generateMessageRegistry)
        ) {
            options.generateMessageRegistry = true;
        } else if (matchesOption(arg, CLI_OPTIONS.dryRun)) {
            options.dryRun = true;
        } else if (matchesOption(arg, CLI_OPTIONS.check)) {
            options.check = true;
        } else if (matchesOption(arg, CLI_OPTIONS.help)) {
            printHelp();
            process.exit(0);
        }
    }

    return options as CliOptions;
}

function printHelp(): void {
    console.log(`
generate-contracts - Extract public message and general contracts from TypeScript source

Usage:
  generate-contracts --output-dir <path> [options]
  generate-contracts --config <path-with-contracts.outputs> [options]

Required:
  -o, --output-dir <path>       Output directory for generated contracts
                                Required unless contracts.outputs is configured

Options:
  -c, --config <path>           Path to config file (default: ${DEFAULT_CONFIG_PATH})
  --include <mode>              Include scope: all, messages, contracts
                                Default: all
  --messages <types>            Filter message types to extract (comma-separated)
                                Valid types: ${VALID_MESSAGE_TYPES.join(", ")}
                                Default: all types
  -m, --message-types <types>   Alias for --messages
  --dependency-strategy <strategy>
                                Dependency copy strategy: file, safe-symbols
                                Default: safe-symbols
  --output-module-specifiers <style>
                                Generated relative module specifiers: js, extensionless
                                Default: js
  --registry                    Generate message registry index.ts file
  --generate-message-registry   Alias for --registry
                                Default: not generated
  --dry-run                     Generate into a temporary directory and print counts
  --check                       Compare generated output against output directory
  -h, --help                    Show this help message

Config file format:
  export default {
    contracts: {
      contexts: [
        "packages/*",                    // glob: auto-discover all contexts
        "packages/auth",                 // string: name inferred from directory
        {
          name: "lecture",
          path: "packages/lecture",       // required: base directory
          sourceDir: "src",              // optional, default: "src"
        },
      ],
      pathAliasRewrites: {
        "@/": "@libera/",
      },
    },
  };

Examples:
  # Extract all message types
  generate-contracts --output-dir packages/contracts/src

  # Extract only commands and queries
  generate-contracts -o packages/contracts/requests --messages command,query

  # Extract only events
  generate-contracts -o packages/contracts/events --message-types event

  # Extract only PublicContract markers
  generate-contracts -o packages/contracts/public --include contracts

  # Generate with message registry (index.ts)
  generate-contracts -o packages/contracts/src --registry

  # Use with custom config
  generate-contracts -c app.config.ts -o packages/contracts/src
`);
}

interface SummaryTotals {
    events: number;
    commands: number;
    queries: number;
    publicContracts: number;
    files: number;
}

function calculateSummaryTotals(results: ContextProcessingResult[]): SummaryTotals {
    return results.reduce(
        (totals, contextResult) => ({
            events: totals.events + contextResult.result.events.length,
            commands: totals.commands + contextResult.result.commands.length,
            queries: totals.queries + contextResult.result.queries.length,
            publicContracts:
                totals.publicContracts +
                contextResult.result.publicContracts.length,
            files: totals.files + contextResult.result.copiedFiles.length,
        }),
        { events: 0, commands: 0, queries: 0, publicContracts: 0, files: 0 }
    );
}

function countTotalMessages(totals: SummaryTotals): number {
    return totals.events + totals.commands + totals.queries;
}

function logSummary(logger: Logger, totals: SummaryTotals): void {
    logger.info("\n--- Summary ---");
    logger.info(`Total events: ${totals.events}`);
    logger.info(`Total commands: ${totals.commands}`);
    logger.info(`Total queries: ${totals.queries}`);
    logger.info(`Total public contracts: ${totals.publicContracts}`);
    logger.info(`Total files copied: ${totals.files}`);
}

function formatMessageTypesForLog(messageTypes: readonly MessageType[] | undefined): string {
    if (messageTypes === undefined) {
        return "all";
    }

    if (messageTypes.length === 0) {
        return "none";
    }

    return messageTypes.join(", ");
}

function logGenerationSettings(
    logger: Logger,
    config: ContractsConfig,
    outputPlans: readonly OutputPlan[],
    options: RunWithConfigOptions,
    scope: GenerationScope
): void {
    logger.info(`Found ${config.contexts.length} context(s) to process`);
    if (outputPlans.length === 1 && outputPlans[0].name === "default") {
        logger.info(`Output directory: ${outputPlans[0].outputDir}`);
    } else {
        logger.info(`Outputs: ${outputPlans.length}`);
        for (const output of outputPlans) {
            logger.info(`  - ${output.name}: ${output.outputDir}`);
        }
    }
    logger.info(`Include mode: ${options.include ?? "all"}`);
    logger.info(
        `Dependency strategy: ${options.dependencyStrategy ?? config.dependencyStrategy}`
    );
    logger.info(
        `Output module specifiers: ${options.outputModuleSpecifiers ?? config.outputModuleSpecifiers}`
    );
    logger.info(`Message types filter: ${formatMessageTypesForLog(scope.messageTypes)}`);
    logger.info(
        `Public contracts: ${scope.includePublicContracts ? "included" : "excluded"}`
    );

    if (options.dryRun) {
        logger.info("Dry run: enabled (target output directory will not be written)");
    }

    if (options.check) {
        logger.info("Check mode: enabled (generated output will be compared only)");
    }
}

function logDryRunDetails(
    logger: Logger,
    results: ContextProcessingResult[]
): void {
    logger.info("\n--- Dry run details ---");

    for (const contextResult of results) {
        const { result } = contextResult;
        logger.info(
            `Context ${contextResult.name}: ` +
                `${result.events.length} event(s), ` +
                `${result.commands.length} command(s), ` +
                `${result.queries.length} query(s), ` +
                `${result.publicContracts.length} public contract(s), ` +
                `${result.copiedFiles.length} copy target(s)`
        );

        for (const file of result.copiedFiles) {
            logger.info(`  - ${relative(contextResult.outputDir, file).replace(/\\/g, "/")}`);
        }
    }
}

async function collectFileContents(
    rootDir: string,
    currentDir = rootDir
): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = join(currentDir, entry.name);

        if (entry.isDirectory()) {
            const nestedFiles = await collectFileContents(rootDir, entryPath);
            for (const [filePath, content] of nestedFiles) {
                files.set(filePath, content);
            }
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativePath = relative(rootDir, entryPath).replace(/\\/g, "/");
        files.set(relativePath, await readFile(entryPath, "utf-8"));
    }

    return files;
}

function listOnlyIn(
    left: ReadonlyMap<string, string>,
    right: ReadonlyMap<string, string>
): string[] {
    return [...left.keys()].filter((filePath) => !right.has(filePath)).sort();
}

function listChangedFiles(
    expected: ReadonlyMap<string, string>,
    actual: ReadonlyMap<string, string>
): string[] {
    return [...expected.keys()]
        .filter((filePath) => actual.has(filePath))
        .filter((filePath) => expected.get(filePath) !== actual.get(filePath))
        .sort();
}

function formatCheckDiffSection(title: string, files: readonly string[]): string | undefined {
    if (files.length === 0) {
        return undefined;
    }

    const visibleFiles = files.slice(0, CHECK_DIFF_LIST_LIMIT);
    const lines = visibleFiles.map((filePath) => `  - ${filePath}`);
    const hiddenCount = files.length - visibleFiles.length;

    if (hiddenCount > 0) {
        lines.push(`  ... and ${hiddenCount} more`);
    }

    return `${title} (${files.length}):\n${lines.join("\n")}`;
}

async function assertOutputMatchesGenerated(
    generatedOutputDir: string,
    outputDir: string,
    logger: Logger
): Promise<void> {
    if (!(await nodeFileSystem.exists(outputDir))) {
        throw new Error(`Check failed: output directory does not exist: ${outputDir}`);
    }

    const [generatedFiles, outputFiles] = await Promise.all([
        collectFileContents(generatedOutputDir),
        collectFileContents(outputDir),
    ]);

    const missingFiles = listOnlyIn(generatedFiles, outputFiles);
    const extraFiles = listOnlyIn(outputFiles, generatedFiles);
    const changedFiles = listChangedFiles(generatedFiles, outputFiles);

    if (
        missingFiles.length === 0 &&
        extraFiles.length === 0 &&
        changedFiles.length === 0
    ) {
        logger.info("Check passed: output directory matches generated contracts");
        return;
    }

    const details = [
        `Check failed: output directory differs from generated contracts: ${outputDir}`,
        formatCheckDiffSection("Missing files", missingFiles),
        formatCheckDiffSection("Extra files", extraFiles),
        formatCheckDiffSection("Changed files", changedFiles),
    ].filter((line): line is string => Boolean(line));

    throw new Error(details.join("\n"));
}

async function generateContracts(
    config: ContractsConfig,
    outputPlan: OutputPlan,
    options: RunWithConfigOptions,
    scope: GenerationScope,
    logger: Logger
): Promise<ContextProcessingResult[]> {
    const outputDir = outputPlan.outputDir;
    const outputModuleSpecifiers =
        outputPlan.outputModuleSpecifiers ??
        options.outputModuleSpecifiers ??
        config.outputModuleSpecifiers;
    const pathAliasRewrites = config.pathAliasRewrites
        ? new Map(Object.entries(config.pathAliasRewrites))
        : undefined;

    const results: ContextProcessingResult[] = [];

    for (const contextConfig of config.contexts) {
        const pipeline = ContractsPipeline.create({
            contextConfig,
            responseNamingConventions: config.responseNamingConventions,
            decoratorNames: config.decoratorNames,
            contractMarkerNames: config.contractMarkerNames,
            trustedDecoratorSources: config.trustedDecoratorSources,
            messageTypes: scope.messageTypes,
            includePublicContracts: scope.includePublicContracts,
            dependencyStrategy:
                options.dependencyStrategy ?? config.dependencyStrategy,
            outputModuleSpecifiers,
            logger,
        });

        const result = await pipeline.execute({
            contextName: contextConfig.name,
            sourceDir: contextConfig.sourceDir,
            outputDir,
            pathAliasRewrites,
            select: outputPlan.select,
            removeDecorators: config.removeDecorators,
            outputModuleSpecifiers,
        });

        results.push({ name: contextConfig.name, result, outputDir });
    }

    const totals = calculateSummaryTotals(results);
    logSummary(logger, totals);

    if (outputPlan.generateMessageRegistry) {
        await generateRegistry(
            outputDir,
            results,
            totals,
            logger,
            outputModuleSpecifiers
        );
    }

    if (config.pathAliasRewrites) {
        await generateReexports(config, outputDir, results, logger);
    }

    return results;
}

function createOutputPlans(
    config: ContractsConfig,
    options: RunWithConfigOptions
): OutputPlan[] {
    if (config.outputs && config.outputs.length > 0) {
        if (options.outputDir) {
            throw new Error(
                "Cannot use --output-dir when contracts.outputs is configured. Remove --output-dir or remove contracts.outputs."
            );
        }

        return config.outputs.map((output) => ({
            name: output.name,
            outputDir: resolve(config.configDir, output.path),
            select: output.select,
            generateMessageRegistry:
                options.generateMessageRegistry === true || output.registry === true,
            outputModuleSpecifiers: output.outputModuleSpecifiers,
        }));
    }

    if (!options.outputDir) {
        throw new Error("Missing required option: --output-dir");
    }

    return [
        {
            name: "default",
            outputDir: resolve(config.configDir, options.outputDir),
            generateMessageRegistry: options.generateMessageRegistry === true,
            outputModuleSpecifiers: options.outputModuleSpecifiers,
        },
    ];
}

function createTemporaryOutputPlans(
    outputPlans: readonly OutputPlan[],
    temporaryOutputDir: string | undefined
): OutputPlan[] {
    if (!temporaryOutputDir) {
        return [...outputPlans];
    }

    return outputPlans.map((output) => ({
        ...output,
        outputDir: join(temporaryOutputDir, output.name),
    }));
}

async function runGeneration(
    config: ContractsConfig,
    options: RunWithConfigOptions,
    logger: Logger
): Promise<void> {
    const scope = resolveGenerationScope(options);
    const outputPlans = createOutputPlans(config, options);
    logGenerationSettings(logger, config, outputPlans, options, scope);

    const shouldUseTemporaryOutput = options.dryRun || options.check;
    const temporaryOutputDir = shouldUseTemporaryOutput
        ? await mkdtemp(join(tmpdir(), "contracts-generator-"))
        : undefined;
    if (temporaryOutputDir) {
        logger.info(`Temporary output directory: ${temporaryOutputDir}`);
    }

    try {
        const generationPlans = createTemporaryOutputPlans(
            outputPlans,
            temporaryOutputDir
        );
        const allResults: ContextProcessingResult[] = [];

        for (const outputPlan of generationPlans) {
            if (generationPlans.length > 1) {
                logger.info(`\n--- Output: ${outputPlan.name} ---`);
            }

            const results = await generateContracts(
                config,
                outputPlan,
                options,
                scope,
                logger
            );
            allResults.push(...results);
        }

        if (options.dryRun) {
            logDryRunDetails(logger, allResults);
        }

        if (options.check) {
            const generationPlansByName = new Map(
                generationPlans.map((plan) => [plan.name, plan])
            );

            for (const outputPlan of outputPlans) {
                const generatedPlan = generationPlansByName.get(outputPlan.name)!;
                await assertOutputMatchesGenerated(
                    generatedPlan.outputDir,
                    outputPlan.outputDir,
                    logger
                );
            }
        }
    } finally {
        if (temporaryOutputDir) {
            await rm(temporaryOutputDir, { recursive: true, force: true });
        }
    }
}

export async function run(args: string[]): Promise<void> {
    const options = parseArgs(args);
    const configPath = resolve(options.config);
    const logger = new ConsoleLogger({ level: "info" });

    logger.info(`Loading config from: ${configPath}`);

    const configLoader = new ConfigLoader();
    const config = await configLoader.load(configPath);

    await runGeneration(config, options, logger);
}

/**
 * Converts plugin config to internal ContractsConfig format.
 */
async function toContractsConfig(pluginConfig: ContractsPluginConfig): Promise<ContractsConfig> {
    if (Object.prototype.hasOwnProperty.call(pluginConfig, "entryStrategy")) {
        throw new Error(
            "entryStrategy has been removed. Strict symbol entry extraction is always used."
        );
    }

    const contexts = await resolveContextEntries(
        pluginConfig.contexts,
        process.cwd(),
        nodeFileSystem
    );

    return {
        configDir: process.cwd(),
        contexts,
        outputs: validateContractOutputs(pluginConfig.outputs),
        pathAliasRewrites: pluginConfig.pathAliasRewrites,
        externalDependencies: pluginConfig.externalDependencies,
        decoratorNames: mergeDecoratorNames(pluginConfig.decoratorNames),
        contractMarkerNames: mergeContractMarkerNames(
            pluginConfig.contractMarkerNames
        ),
        trustedDecoratorSources: validateTrustedDecoratorSources(
            pluginConfig.trustedDecoratorSources
        ),
        dependencyStrategy: validateDependencyStrategy(
            pluginConfig.dependencyStrategy
        ),
        outputModuleSpecifiers: validateOutputModuleSpecifiers(
            pluginConfig.outputModuleSpecifiers
        ),
        responseNamingConventions: pluginConfig.responseNamingConventions,
        removeDecorators: pluginConfig.removeDecorators ?? true,
    };
}

/**
 * Run contracts generator with config provided directly.
 * This is used by the hexai CLI integration where config comes from hexai.config.ts.
 *
 * @param options - CLI options (outputDir, messageTypes, generateMessageRegistry)
 * @param pluginConfig - Plugin configuration from hexai.config.ts
 */
export async function runWithConfig(
    options: RunWithConfigOptions,
    pluginConfig: ContractsPluginConfig
): Promise<void> {
    const logger = new ConsoleLogger({ level: "info" });
    const config = await toContractsConfig(pluginConfig);

    await runGeneration(config, options, logger);
}

async function generateRegistry(
    outputDir: string,
    results: ContextProcessingResult[],
    totals: SummaryTotals,
    logger: Logger,
    outputModuleSpecifiers: OutputModuleSpecifiers
): Promise<void> {
    const contextMessages: ContextMessages[] = results.map((contextResult) => {
        const contextOutputDir = join(contextResult.outputDir, contextResult.name);
        const relativeContextDir = relative(outputDir, contextOutputDir).replace(/\\/g, "/");
        const relativeContextPath = relativeContextDir
            ? `./${relativeContextDir}`
            : ".";
        const importPath = formatRelativeIndexSpecifier(
            relativeContextPath,
            outputModuleSpecifiers
        );

        return {
            contextName: contextResult.name,
            events: contextResult.result.events,
            commands: contextResult.result.commands,
            queries: contextResult.result.queries,
            importPath,
        };
    });

    const generator = new RegistryGenerator({
        useNamespace: true,
        outputModuleSpecifiers,
    });
    const registryContent = generator.generate(contextMessages);

    await nodeFileSystem.mkdir(outputDir, { recursive: true });
    const indexPath = join(outputDir, "index.ts");
    await nodeFileSystem.writeFile(indexPath, registryContent);

    logger.info(`  Generated index.ts with ${countTotalMessages(totals)} message(s)`);
}

async function generateReexports(
    config: ContractsConfig,
    outputDir: string,
    results: ContextProcessingResult[],
    logger: Logger
): Promise<void> {
    logger.info("\n--- Generating re-exports for pathAliasRewrites ---");

    const pathAliasRewrites = new Map(Object.entries(config.pathAliasRewrites!));
    const allCopiedFiles = results.flatMap((contextResult) => contextResult.result.copiedFiles);

    const generator = new ReexportGenerator({ fileSystem: nodeFileSystem });

    const reexportFiles = await generator.analyze({
        files: allCopiedFiles,
        pathAliasRewrites,
    });

    if (reexportFiles.length === 0) {
        logger.info("  No re-export files needed");
        return;
    }

    const generatedFiles = await generator.generate({
        outputDir,
        reexportFiles,
    });

    logger.info(`  Generated ${generatedFiles.length} re-export file(s):`);
    for (const file of generatedFiles) {
        logger.info(`    - ${relative(outputDir, file)}`);
    }
}

async function main(): Promise<void> {
    try {
        await run(process.argv.slice(2));
    } catch (error) {
        if (error instanceof Error) {
            console.error(`Error: ${error.message}`);
        } else {
            console.error("Unknown error occurred");
        }
        process.exit(EXIT_CODE_ERROR);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
