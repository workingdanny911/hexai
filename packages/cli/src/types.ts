/**
 * CLI option definition for a hexai plugin command.
 */
export interface CliOption {
    /**
     * Commander.js-style flag definition.
     * @example "-o, --output-dir <path>"
     * @example "-c, --config [path]"
     * @example "-v, --verbose"
     */
    flags: string;

    /**
     * Description shown in help output.
     */
    description: string;

    /**
     * Whether this option is required.
     * @default false
     */
    required?: boolean;

    /**
     * Default value for this option.
     */
    defaultValue?: string;
}

/**
 * Interface that hexai plugins must implement to provide CLI commands.
 *
 * Each plugin exports a `cliPlugin` constant that satisfies this interface.
 * The CLI tool dynamically loads plugins from `hexai.config.ts` and
 * registers them as Commander.js subcommands.
 *
 * @example
 * ```ts
 * // In @hexaijs/plugin-contracts-generator
 * export const cliPlugin: HexaiCliPlugin = {
 *     name: "generate-contracts",
 *     description: "Extract domain events and commands from bounded contexts",
 *     options: [
 *         {
 *             flags: "-o, --output-dir <path>",
 *             description: "Output directory for generated contracts",
 *             required: true,
 *         },
 *     ],
 *     run: async (args, config) => {
 *         // config contains plugin-specific configuration from hexai.config.ts
 *         await generateContracts(args.outputDir, config);
 *     },
 * };
 * ```
 */
export interface HexaiCliPlugin<TConfig = unknown> {
    /**
     * Command name used as the subcommand.
     * @example "generate-contracts" → `pnpm hexai generate-contracts`
     */
    name: string;

    /**
     * Description shown in help output.
     */
    description: string;

    /**
     * CLI options for this command.
     */
    options: CliOption[];

    /**
     * Entry point for the command.
     * Called with parsed CLI arguments and plugin configuration.
     *
     * @param args - Parsed CLI arguments from command line
     * @param config - Plugin-specific configuration from hexai.config.ts
     */
    run: (args: Record<string, unknown>, config: TConfig) => Promise<void>;
}

/**
 * Plugin entry in hexai configuration.
 * Each entry specifies the plugin package and its configuration.
 *
 * @example
 * ```ts
 * {
 *     plugin: "@hexaijs/plugin-contracts-generator",
 *     config: {
 *         contexts: [...],
 *         responseNamingConventions: [...],
 *     },
 * }
 * ```
 */
export interface PluginEntry<TConfig = unknown> {
    /**
     * Plugin package name.
     * Must export `cliPlugin: HexaiCliPlugin`.
     */
    plugin: string;

    /**
     * Plugin-specific configuration.
     * Passed to `plugin.run(args, config)` when the command is executed.
     */
    config: TConfig;
}

/**
 * Configuration for hexai CLI.
 * Loaded from `hexai.config.ts`, `hexai.config.js`, or `hexai.config.json`.
 *
 * @example
 * ```ts
 * export default {
 *     plugins: [
 *         {
 *             plugin: "@hexaijs/plugin-contracts-generator",
 *             config: {
 *                 contexts: [...],
 *             },
 *         },
 *     ],
 * };
 * ```
 */
export interface HexaiConfig {
    /**
     * List of plugins with their configurations.
     * Each plugin entry specifies the package name and its config.
     */
    plugins: PluginEntry[];
}
