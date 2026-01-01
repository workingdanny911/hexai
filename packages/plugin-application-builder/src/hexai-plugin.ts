import type { HexaiCliPlugin, CliOption } from "@hexaijs/cli";
import * as path from "path";
import { generateApplicationBuilder } from "./index";

/**
 * Configuration for the application-builder plugin.
 * Since this plugin uses per-context config files (hexai.config.ts),
 * the root hexai.config.ts config is minimal.
 */
export interface ApplicationBuilderPluginConfig {
    /**
     * Default config file name to look for in each context.
     * Defaults to "hexai.config.ts".
     */
    configFile?: string;
}

/**
 * CLI plugin definition for hexai integration.
 *
 * This allows the application builder to be invoked via `pnpm hexai generate-app-builder`.
 * Each bounded context should have its own `hexai.config.ts` file.
 *
 * @example
 * ```bash
 * # Generate for a specific context
 * pnpm hexai generate-app-builder --context-path packages/assignment
 *
 * # Use a custom config file name
 * pnpm hexai generate-app-builder --context-path packages/assignment --config-file custom.config.ts
 * ```
 */
export const cliPlugin: HexaiCliPlugin<ApplicationBuilderPluginConfig> = {
    name: "generate-app-builder",
    description: "Generate ApplicationBuilder code from decorated handlers",
    options: [
        {
            flags: "-p, --context-path <path>",
            description: "Path to the bounded context directory",
            required: true,
        },
        {
            flags: "-f, --config-file <name>",
            description: "Config file name to use (default: hexai.config.ts)",
        },
    ] satisfies CliOption[],
    run: async (
        args: Record<string, unknown>,
        config: ApplicationBuilderPluginConfig
    ): Promise<void> => {
        const contextPath = path.resolve(String(args.contextPath));

        // Priority: CLI arg > hexai.config.ts plugin config > default
        const configFile =
            args.configFile !== undefined
                ? String(args.configFile)
                : config.configFile;

        console.log(`Generating application builder for: ${contextPath}`);

        await generateApplicationBuilder(contextPath, {
            configFile,
        });

        console.log("✓ Application builder generated successfully");
    },
};
