import * as fs from "node:fs";
import * as path from "node:path";
import { HexaiConfig, PluginEntry } from "./types";

/**
 * Supported config file names in order of priority.
 */
export const CONFIG_FILE_NAMES = [
    "hexai.config.ts",
    "hexai.config.js",
    "hexai.config.json",
] as const;

/**
 * Options for loading hexai configuration.
 */
export interface LoadConfigOptions {
    /**
     * Starting directory for config file search.
     * @default process.cwd()
     */
    cwd?: string;

    /**
     * Search parent directories if config not found in starting directory.
     * @default false
     */
    searchParents?: boolean;
}

/**
 * Result of loading a config file.
 */
export interface LoadConfigResult {
    /**
     * The loaded configuration.
     */
    config: HexaiConfig;

    /**
     * Absolute path to the config file that was loaded.
     */
    configPath: string;
}

/**
 * Error thrown when no config file is found.
 */
export class ConfigNotFoundError extends Error {
    constructor(searchedPaths: string[]) {
        super(
            `No hexai config file found. Searched for:\n${searchedPaths.map((p) => `  - ${p}`).join("\n")}`
        );
        this.name = "ConfigNotFoundError";
    }
}

/**
 * Error thrown when config file is invalid.
 */
export class ConfigLoadError extends Error {
    constructor(configPath: string, cause: unknown) {
        const causeMessage =
            cause instanceof Error ? cause.message : String(cause);
        super(`Failed to load config from ${configPath}: ${causeMessage}`);
        this.name = "ConfigLoadError";
        this.cause = cause;
    }
}

interface FindConfigFileResult {
    configPath: string | null;
    searchedPaths: string[];
}

function traverseDirectoriesForConfig(
    startDir: string,
    searchParents: boolean
): FindConfigFileResult {
    let currentDir = path.resolve(startDir);
    const searchedPaths: string[] = [];

    while (true) {
        for (const fileName of CONFIG_FILE_NAMES) {
            const configPath = path.join(currentDir, fileName);
            searchedPaths.push(configPath);

            if (fs.existsSync(configPath)) {
                return { configPath, searchedPaths };
            }
        }

        if (!searchParents) {
            break;
        }

        const parentDir = path.dirname(currentDir);
        const reachedFilesystemRoot = parentDir === currentDir;
        if (reachedFilesystemRoot) {
            break;
        }
        currentDir = parentDir;
    }

    return { configPath: null, searchedPaths };
}

/**
 * Finds the config file path by searching in the given directory
 * and optionally parent directories.
 *
 * @param options - Search options
 * @returns Path to the config file, or null if not found
 */
export function findConfigFile(options: LoadConfigOptions = {}): string | null {
    const { cwd = process.cwd(), searchParents = false } = options;
    const { configPath } = traverseDirectoriesForConfig(cwd, searchParents);
    return configPath;
}

/**
 * Loads the hexai config from a specific file path.
 *
 * @param configPath - Absolute path to the config file
 * @returns The loaded configuration
 * @throws {ConfigLoadError} If the config file cannot be loaded or is invalid
 */
export async function loadConfigFromPath(
    configPath: string
): Promise<HexaiConfig> {
    const ext = path.extname(configPath);

    try {
        if (ext === ".json") {
            const content = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(content);
            return validateConfig(config, configPath);
        }

        // For .ts and .js files, use dynamic import
        // Convert to file:// URL for cross-platform compatibility
        const fileUrl = `file://${configPath}`;
        const module = await import(fileUrl);
        const config = module.default ?? module;
        return validateConfig(config, configPath);
    } catch (error) {
        if (error instanceof ConfigLoadError) {
            throw error;
        }
        throw new ConfigLoadError(configPath, error);
    }
}

/**
 * Validates that the loaded config has the required structure.
 *
 * @param config - The loaded config object
 * @param configPath - Path to the config file (for error messages)
 * @returns The validated config
 * @throws {ConfigLoadError} If the config is invalid
 */
function validateConfig(config: unknown, configPath: string): HexaiConfig {
    if (typeof config !== "object" || config === null) {
        throw new ConfigLoadError(
            configPath,
            new Error("Config must be an object")
        );
    }

    const configObj = config as Record<string, unknown>;

    if (!Array.isArray(configObj.plugins)) {
        throw new ConfigLoadError(
            configPath,
            new Error("Config must have a 'plugins' array")
        );
    }

    const plugins = configObj.plugins as unknown[];
    for (let i = 0; i < plugins.length; i++) {
        validatePluginEntry(plugins[i], i, configPath);
    }

    return {
        plugins: plugins as PluginEntry[],
    };
}

/**
 * Validates a single plugin entry.
 *
 * @param entry - The plugin entry to validate
 * @param index - Index in the plugins array (for error messages)
 * @param configPath - Path to the config file (for error messages)
 * @throws {ConfigLoadError} If the entry is invalid
 */
function validatePluginEntry(
    entry: unknown,
    index: number,
    configPath: string
): asserts entry is PluginEntry {
    if (typeof entry !== "object" || entry === null) {
        throw new ConfigLoadError(
            configPath,
            new Error(
                `plugins[${index}] must be an object with 'plugin' and 'config' properties`
            )
        );
    }

    const entryObj = entry as Record<string, unknown>;

    if (typeof entryObj.plugin !== "string" || entryObj.plugin.length === 0) {
        throw new ConfigLoadError(
            configPath,
            new Error(
                `plugins[${index}].plugin must be a non-empty string (plugin package name)`
            )
        );
    }

    if (!("config" in entryObj)) {
        throw new ConfigLoadError(
            configPath,
            new Error(
                `plugins[${index}].config is required (use empty object {} if no config needed)`
            )
        );
    }
}

/**
 * Loads the hexai configuration by searching for a config file.
 *
 * Searches for config files in the following order:
 * 1. hexai.config.ts
 * 2. hexai.config.js
 * 3. hexai.config.json
 *
 * @param options - Load options
 * @returns The loaded config and its path
 * @throws {ConfigNotFoundError} If no config file is found
 * @throws {ConfigLoadError} If the config file cannot be loaded or is invalid
 *
 * @example
 * ```ts
 * // Load from current directory
 * const { config, configPath } = await loadConfig();
 *
 * // Load from specific directory, searching parent directories
 * const { config, configPath } = await loadConfig({
 *     cwd: "/path/to/project",
 *     searchParents: true,
 * });
 * ```
 */
export async function loadConfig(
    options: LoadConfigOptions = {}
): Promise<LoadConfigResult> {
    const { cwd = process.cwd(), searchParents = false } = options;

    const { configPath, searchedPaths } = traverseDirectoriesForConfig(cwd, searchParents);

    if (!configPath) {
        throw new ConfigNotFoundError(searchedPaths);
    }

    const config = await loadConfigFromPath(configPath);
    return { config, configPath };
}
