#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";
import { ConfigLoader, type ContractsConfig, resolveContextEntries } from "./config-loader";
import type { InputContextConfig } from "./context-config";
import { ContractsPipeline, type PipelineResult, ConsoleLogger, type Logger } from "./index";
import { RegistryGenerator, ContextMessages } from "./registry-generator";
import { ReexportGenerator } from "./reexport-generator";
import { nodeFileSystem } from "./file-system";
import type { MessageType, DecoratorNames, ResponseNamingConvention } from "./domain/types";
import { mergeDecoratorNames } from "./domain";

const DEFAULT_CONFIG_PATH = "application.config.ts";
const EXIT_CODE_ERROR = 1;
const VALID_MESSAGE_TYPES: MessageType[] = ["event", "command", "query"];

const CLI_OPTIONS = {
    config: { short: "-c", long: "--config", requiresValue: true },
    outputDir: { short: "-o", long: "--output-dir", requiresValue: true },
    messageTypes: { short: "-m", long: "--message-types", requiresValue: true },
    generateMessageRegistry: { short: null, long: "--generate-message-registry", requiresValue: false },
    help: { short: "-h", long: "--help", requiresValue: false },
} as const;

interface CliOptions {
    config: string;
    outputDir: string;
    messageTypes?: MessageType[];
    generateMessageRegistry?: boolean;
}

/**
 * Options for runWithConfig when config is provided directly.
 */
export interface RunWithConfigOptions {
    outputDir: string;
    messageTypes?: MessageType[];
    generateMessageRegistry?: boolean;
}

/**
 * Plugin configuration structure for contracts generator.
 * This is the config passed from hexai.config.ts.
 */
export interface ContractsPluginConfig {
    contexts: Array<string | InputContextConfig>;
    pathAliasRewrites?: Record<string, string>;
    externalDependencies?: Record<string, string>;
    decoratorNames?: DecoratorNames;
    responseNamingConventions?: ResponseNamingConvention[];
    removeDecorators?: boolean;
}

interface ContextProcessingResult {
    name: string;
    result: PipelineResult;
    outputDir: string;
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
        } else if (matchesOption(arg, CLI_OPTIONS.messageTypes)) {
            const { value, nextIndex } = extractOptionValue(args, i, "--message-types");
            options.messageTypes = parseMessageTypes(value);
            i = nextIndex;
        } else if (matchesOption(arg, CLI_OPTIONS.generateMessageRegistry)) {
            options.generateMessageRegistry = true;
        } else if (matchesOption(arg, CLI_OPTIONS.help)) {
            printHelp();
            process.exit(0);
        }
    }

    if (!options.outputDir) {
        throw new Error("Missing required option: --output-dir");
    }

    return options as CliOptions;
}

function printHelp(): void {
    console.log(`
contracts-generator - Extract domain events and commands from TypeScript source

Usage:
  contracts-generator --output-dir <path> [options]

Required:
  -o, --output-dir <path>       Output directory for generated contracts

Options:
  -c, --config <path>           Path to config file (default: ${DEFAULT_CONFIG_PATH})
  -m, --message-types <types>   Filter message types to extract (comma-separated)
                                Valid types: ${VALID_MESSAGE_TYPES.join(", ")}
                                Default: all types
  --generate-message-registry   Generate message registry index.ts file
                                Default: not generated
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
  contracts-generator --output-dir packages/contracts/src

  # Extract only commands and queries
  contracts-generator -o packages/contracts/requests -m command,query

  # Extract only events
  contracts-generator -o packages/contracts/events --message-types event

  # Generate with message registry (index.ts)
  contracts-generator -o packages/contracts/src --generate-message-registry

  # Use with custom config
  contracts-generator -c app.config.ts -o packages/contracts/src
`);
}

interface SummaryTotals {
    events: number;
    commands: number;
    files: number;
}

function calculateSummaryTotals(results: ContextProcessingResult[]): SummaryTotals {
    return results.reduce(
        (totals, contextResult) => ({
            events: totals.events + contextResult.result.events.length,
            commands: totals.commands + contextResult.result.commands.length,
            files: totals.files + contextResult.result.copiedFiles.length,
        }),
        { events: 0, commands: 0, files: 0 }
    );
}

function countTotalMessages(totals: SummaryTotals): number {
    return totals.events + totals.commands;
}

function logSummary(logger: Logger, totals: SummaryTotals): void {
    logger.info("\n--- Summary ---");
    logger.info(`Total events: ${totals.events}`);
    logger.info(`Total commands: ${totals.commands}`);
    logger.info(`Total files copied: ${totals.files}`);
}

export async function run(args: string[]): Promise<void> {
    const options = parseArgs(args);
    const configPath = resolve(options.config);
    const configDir = dirname(configPath);
    const outputDir = resolve(configDir, options.outputDir);
    const logger = new ConsoleLogger({ level: "info" });

    logger.info(`Loading config from: ${configPath}`);

    const configLoader = new ConfigLoader();
    const config = await configLoader.load(configPath);

    logger.info(`Found ${config.contexts.length} context(s) to process`);
    logger.info(`Output directory: ${outputDir}`);
    if (options.messageTypes) {
        logger.info(`Message types filter: ${options.messageTypes.join(", ")}`);
    }

    const pathAliasRewrites = config.pathAliasRewrites
        ? new Map(Object.entries(config.pathAliasRewrites))
        : undefined;

    const results: ContextProcessingResult[] = [];

    for (const contextConfig of config.contexts) {
        const pipeline = ContractsPipeline.create({
            contextConfig,
            messageTypes: options.messageTypes,
            logger,
        });

        const result = await pipeline.execute({
            contextName: contextConfig.name,
            sourceDir: contextConfig.sourceDir,
            outputDir,
            pathAliasRewrites,
            removeDecorators: config.removeDecorators,
        });

        results.push({ name: contextConfig.name, result, outputDir });
    }

    const totals = calculateSummaryTotals(results);
    logSummary(logger, totals);

    if (options.generateMessageRegistry) {
        await generateRegistry(outputDir, results, totals, logger);
    }

    if (config.pathAliasRewrites) {
        await generateReexports(config, outputDir, results, logger);
    }
}

/**
 * Converts plugin config to internal ContractsConfig format.
 */
async function toContractsConfig(pluginConfig: ContractsPluginConfig): Promise<ContractsConfig> {
    const contexts = await resolveContextEntries(
        pluginConfig.contexts,
        process.cwd(),
        nodeFileSystem
    );

    return {
        contexts,
        pathAliasRewrites: pluginConfig.pathAliasRewrites,
        externalDependencies: pluginConfig.externalDependencies,
        decoratorNames: mergeDecoratorNames(pluginConfig.decoratorNames),
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
    const outputDir = resolve(options.outputDir);
    const logger = new ConsoleLogger({ level: "info" });
    const config = await toContractsConfig(pluginConfig);

    logger.info(`Found ${config.contexts.length} context(s) to process`);
    logger.info(`Output directory: ${outputDir}`);
    if (options.messageTypes) {
        logger.info(`Message types filter: ${options.messageTypes.join(", ")}`);
    }

    const pathAliasRewrites = config.pathAliasRewrites
        ? new Map(Object.entries(config.pathAliasRewrites))
        : undefined;

    const results: ContextProcessingResult[] = [];

    for (const contextConfig of config.contexts) {
        const pipeline = ContractsPipeline.create({
            contextConfig,
            messageTypes: options.messageTypes,
            logger,
        });

        const result = await pipeline.execute({
            contextName: contextConfig.name,
            sourceDir: contextConfig.sourceDir,
            outputDir,
            pathAliasRewrites,
            removeDecorators: config.removeDecorators,
        });

        results.push({ name: contextConfig.name, result, outputDir });
    }

    const totals = calculateSummaryTotals(results);
    logSummary(logger, totals);

    if (options.generateMessageRegistry) {
        await generateRegistry(outputDir, results, totals, logger);
    }

    if (config.pathAliasRewrites) {
        await generateReexports(config, outputDir, results, logger);
    }
}

async function generateRegistry(
    outputDir: string,
    results: ContextProcessingResult[],
    totals: SummaryTotals,
    logger: Logger
): Promise<void> {
    const contextMessages: ContextMessages[] = results.map((contextResult) => {
        const contextOutputDir = join(contextResult.outputDir, contextResult.name);
        const importPath = "./" + relative(outputDir, contextOutputDir).replace(/\\/g, "/");

        return {
            contextName: contextResult.name,
            events: contextResult.result.events,
            commands: contextResult.result.commands,
            queries: contextResult.result.queries,
            importPath,
        };
    });

    const generator = new RegistryGenerator({ useNamespace: true });
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
