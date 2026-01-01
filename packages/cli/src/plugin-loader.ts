import { HexaiCliPlugin, PluginEntry } from "./types";

/**
 * Error thrown when a plugin cannot be resolved (not installed).
 */
export class PluginNotFoundError extends Error {
    constructor(
        public readonly pluginName: string,
        cause?: unknown
    ) {
        const causeMessage = cause instanceof Error ? `: ${cause.message}` : "";
        super(`Plugin "${pluginName}" not found${causeMessage}`);
        this.name = "PluginNotFoundError";
        this.cause = cause;
    }
}

/**
 * Error thrown when a plugin module doesn't export `cliPlugin`.
 */
export class PluginExportError extends Error {
    constructor(public readonly pluginName: string) {
        super(
            `Plugin "${pluginName}" does not export 'cliPlugin'. ` +
                `Each plugin must export: export const cliPlugin: HexaiCliPlugin = { ... }`
        );
        this.name = "PluginExportError";
    }
}

/**
 * Error thrown when the exported `cliPlugin` is invalid.
 */
export class PluginValidationError extends Error {
    constructor(
        public readonly pluginName: string,
        public readonly reason: string
    ) {
        super(`Plugin "${pluginName}" has invalid cliPlugin: ${reason}`);
        this.name = "PluginValidationError";
    }
}

/**
 * Result of loading a plugin.
 */
export interface LoadPluginResult {
    /**
     * The plugin package name.
     */
    pluginName: string;

    /**
     * The loaded plugin.
     */
    plugin: HexaiCliPlugin;

    /**
     * Plugin-specific configuration from hexai.config.ts.
     */
    config: unknown;
}

/**
 * Validates that a loaded plugin has the required structure.
 *
 * @param plugin - The plugin object to validate
 * @param pluginName - Plugin name for error messages
 * @returns The validated plugin
 * @throws {PluginValidationError} If the plugin structure is invalid
 */
function validatePlugin(plugin: unknown, pluginName: string): HexaiCliPlugin {
    if (typeof plugin !== "object" || plugin === null) {
        throw new PluginValidationError(
            pluginName,
            "cliPlugin must be an object"
        );
    }

    const p = plugin as Record<string, unknown>;

    if (typeof p.name !== "string" || p.name.length === 0) {
        throw new PluginValidationError(
            pluginName,
            "'name' must be a non-empty string"
        );
    }

    if (typeof p.description !== "string") {
        throw new PluginValidationError(
            pluginName,
            "'description' must be a string"
        );
    }

    if (!Array.isArray(p.options)) {
        throw new PluginValidationError(
            pluginName,
            "'options' must be an array"
        );
    }

    if (typeof p.run !== "function") {
        throw new PluginValidationError(pluginName, "'run' must be a function");
    }

    return plugin as HexaiCliPlugin;
}

/**
 * Loads a single plugin from a plugin entry.
 *
 * The plugin package must export `cliPlugin: HexaiCliPlugin`.
 *
 * @param entry - Plugin entry with package name and configuration
 * @returns The loaded plugin result including config
 * @throws {PluginNotFoundError} If the plugin package cannot be resolved
 * @throws {PluginExportError} If the plugin doesn't export `cliPlugin`
 * @throws {PluginValidationError} If the exported `cliPlugin` is invalid
 *
 * @example
 * ```ts
 * const { plugin, config } = await loadPlugin({
 *     plugin: "@hexaijs/plugin-contracts-generator",
 *     config: { contexts: [...] },
 * });
 * console.log(plugin.name); // "generate-contracts"
 * ```
 */
export async function loadPlugin(
    entry: PluginEntry
): Promise<LoadPluginResult> {
    const { plugin: pluginName, config } = entry;
    let module: Record<string, unknown>;

    try {
        module = await import(pluginName);
    } catch (error) {
        throw new PluginNotFoundError(pluginName, error);
    }

    const cliPlugin = module.cliPlugin;

    if (cliPlugin === undefined) {
        throw new PluginExportError(pluginName);
    }

    const validatedPlugin = validatePlugin(cliPlugin, pluginName);

    return {
        pluginName,
        plugin: validatedPlugin,
        config,
    };
}

/**
 * Loads multiple plugins from plugin entries.
 *
 * Plugins are loaded sequentially to provide clear error messages
 * when a specific plugin fails to load.
 *
 * @param entries - Array of plugin entries with configurations
 * @returns Array of loaded plugin results including configs
 * @throws {PluginNotFoundError} If any plugin package cannot be resolved
 * @throws {PluginExportError} If any plugin doesn't export `cliPlugin`
 * @throws {PluginValidationError} If any exported `cliPlugin` is invalid
 *
 * @example
 * ```ts
 * const results = await loadPlugins([
 *     { plugin: "@hexaijs/plugin-contracts-generator", config: { contexts: [...] } },
 *     { plugin: "@hexaijs/plugin-application-builder", config: {} },
 * ]);
 *
 * for (const { plugin, config } of results) {
 *     console.log(`Loaded: ${plugin.name}`);
 * }
 * ```
 */
export async function loadPlugins(
    entries: PluginEntry[]
): Promise<LoadPluginResult[]> {
    const results: LoadPluginResult[] = [];

    for (const entry of entries) {
        const result = await loadPlugin(entry);
        results.push(result);
    }

    return results;
}
