#!/usr/bin/env node

export * from "./types";
export * from "./config-loader";
export * from "./plugin-loader";

import * as path from "node:path";
import { Command } from "commander";
import {
    loadConfig,
    loadConfigFromPath,
    ConfigNotFoundError,
    ConfigLoadError,
} from "./config-loader";
import {
    loadPlugins,
    PluginNotFoundError,
    PluginExportError,
    PluginValidationError,
} from "./plugin-loader";
import type { HexaiCliPlugin, CliOption, HexaiConfig } from "./types";

const EXIT_CODE_ERROR = 1;

/**
 * Options for creating the CLI program.
 */
export interface CreateProgramOptions {
    /**
     * Path to config file. If not specified, searches for config file.
     */
    configPath?: string;

    /**
     * Arguments to parse for finding --config option.
     * Defaults to process.argv.
     */
    argv?: string[];
}

/**
 * Pre-parses argv to extract the --config option value.
 * This is needed because we need to load config before Commander parses.
 *
 * @param argv - Command line arguments
 * @returns Config path if specified, undefined otherwise
 */
function extractConfigPath(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        const isEqualsFormat =
            arg.startsWith("--config=") || arg.startsWith("-c=");
        if (isEqualsFormat) {
            const value = arg.split("=")[1];
            return value || undefined;
        }

        const isSpaceSeparatedFormat = arg === "--config" || arg === "-c";
        if (isSpaceSeparatedFormat) {
            const value = argv[i + 1];
            return value || undefined;
        }
    }

    return undefined;
}

/**
 * Creates the hexai CLI program with loaded plugins.
 *
 * @param options - Program creation options
 * @returns Configured Commander program
 */
export async function createProgram(
    options: CreateProgramOptions = {}
): Promise<Command> {
    const program = new Command();

    program
        .name("hexai")
        .description("Unified CLI tool for hexai plugins")
        .version("0.1.0")
        .option("-c, --config <path>", "Path to hexai config file");

    const argv = options.argv ?? process.argv;
    const configPathFromArgv = extractConfigPath(argv);
    const configPath = options.configPath ?? configPathFromArgv;
    const config = await resolveConfig(configPath);

    const pluginResults = await loadPlugins(config.plugins);
    for (const { plugin, pluginName, config: pluginConfig } of pluginResults) {
        registerPluginCommand(program, plugin, pluginName, pluginConfig);
    }

    return program;
}

/**
 * Resolves the hexai configuration.
 * If a specific path is given, loads from that path.
 * Otherwise, searches for config file starting from cwd.
 *
 * @param configPath - Optional explicit config file path
 * @returns The loaded configuration
 */
async function resolveConfig(configPath?: string): Promise<HexaiConfig> {
    if (configPath) {
        const resolvedPath = path.resolve(configPath);
        return loadConfigFromPath(resolvedPath);
    }

    const { config } = await loadConfig({
        cwd: process.cwd(),
        searchParents: true,
    });

    return config;
}

/**
 * Registers a plugin as a Commander subcommand.
 *
 * @param program - The Commander program instance
 * @param plugin - The plugin to register
 * @param pluginName - Package name of the plugin (for error messages)
 * @param pluginConfig - Plugin-specific configuration from hexai.config.ts
 */
function registerPluginCommand(
    program: Command,
    plugin: HexaiCliPlugin,
    pluginName: string,
    pluginConfig: unknown
): void {
    const command = program
        .command(plugin.name)
        .description(plugin.description);

    for (const opt of plugin.options) {
        addOptionToCommand(command, opt);
    }

    command.action(async (options: Record<string, unknown>) => {
        try {
            await plugin.run(options, pluginConfig);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`Error running ${plugin.name}: ${message}`);
            process.exit(EXIT_CODE_ERROR);
        }
    });
}

/**
 * Adds a CliOption to a Commander command.
 *
 * @param command - The Commander command
 * @param opt - The CLI option definition
 */
function addOptionToCommand(command: Command, opt: CliOption): void {
    if (opt.required) {
        command.requiredOption(opt.flags, opt.description, opt.defaultValue);
    } else {
        command.option(opt.flags, opt.description, opt.defaultValue);
    }
}

/**
 * Main CLI entry point.
 * Loads config, loads plugins, registers commands, and runs the CLI.
 */
export async function main(): Promise<void> {
    try {
        const program = await createProgram();
        await program.parseAsync(process.argv);
    } catch (error) {
        handleError(error);
        process.exit(EXIT_CODE_ERROR);
    }
}

/**
 * Handles errors with user-friendly messages.
 *
 * @param error - The error to handle
 */
export function handleError(error: unknown): void {
    if (error instanceof ConfigNotFoundError) {
        console.error("Configuration Error:", error.message);
        console.error("\nTo use hexai, create a hexai.config.ts file:");
        console.error(`
export default {
    plugins: [
        {
            plugin: "@hexaijs/plugin-contracts-generator",
            config: {
                // Plugin-specific configuration here
            },
        },
    ],
};
`);
        return;
    }

    if (error instanceof ConfigLoadError) {
        console.error("Configuration Error:", error.message);
        return;
    }

    if (error instanceof PluginNotFoundError) {
        console.error("Plugin Error:", error.message);
        console.error("\nMake sure the plugin is installed:");
        console.error(`  pnpm add ${error.pluginName}`);
        return;
    }

    if (error instanceof PluginExportError) {
        console.error("Plugin Error:", error.message);
        return;
    }

    if (error instanceof PluginValidationError) {
        console.error("Plugin Error:", error.message);
        return;
    }

    if (error instanceof Error) {
        console.error("Error:", error.message);
    } else {
        console.error("An unknown error occurred");
    }
}

// Run the CLI when this file is executed directly
// Note: Using CommonJS pattern since tsconfig outputs CJS
if (require.main === module) {
    main();
}
