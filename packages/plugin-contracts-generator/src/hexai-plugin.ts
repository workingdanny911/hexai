import type { HexaiCliPlugin, CliOption } from "@hexaijs/cli";
import {
    runWithConfig,
    type ContractsPluginConfig,
    type IncludeMode,
    type RunWithConfigOptions,
} from "./cli.js";
import {
    validateDependencyStrategy,
    validateOutputModuleSpecifiers,
} from "./config-loader.js";
import type {
    DependencyStrategy,
    MessageType,
    OutputModuleSpecifiers,
} from "./domain/types.js";

const VALID_MESSAGE_TYPES: MessageType[] = ["event", "command", "query"];
const VALID_INCLUDE_MODES: IncludeMode[] = ["all", "messages", "contracts"];

/**
 * Parses comma-separated message types string into MessageType array.
 */
function parseMessageTypes(value: string): MessageType[] {
    const types = value.split(",").map((type) => type.trim().toLowerCase());
    const invalidTypes = types.filter(
        (type) => !VALID_MESSAGE_TYPES.includes(type as MessageType)
    );

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
        "dependencyStrategy"
    );
}

function parseOutputModuleSpecifiers(value: string): OutputModuleSpecifiers {
    return validateOutputModuleSpecifiers(
        value.trim().toLowerCase() as OutputModuleSpecifiers,
        "outputModuleSpecifiers"
    );
}

function readMessageTypes(args: Record<string, unknown>): MessageType[] | undefined {
    const value = args.messages ?? args.messageTypes;
    return value ? parseMessageTypes(String(value)) : undefined;
}

/**
 * CLI plugin definition for hexai integration.
 *
 * This allows the contracts generator to be invoked via `pnpm hexai generate-contracts`.
 * Configuration is provided via hexai.config.ts.
 *
 * @example
 * ```bash
 * pnpm hexai generate-contracts -o packages/contracts/src
 * pnpm hexai generate-contracts -o packages/contracts/src -m event,command
 * ```
 */
export const cliPlugin: HexaiCliPlugin<ContractsPluginConfig> = {
    name: "generate-contracts",
    description:
        "Extract domain events, commands, and queries from bounded contexts",
    options: [
        {
            flags: "-o, --output-dir <path>",
            description: "Output directory for generated contracts",
            required: false,
        },
        {
            flags: "--include <mode>",
            description: "Include scope: all, messages, contracts",
        },
        {
            flags: "--messages <types>",
            description:
                "Filter message types (comma-separated: event,command,query)",
        },
        {
            flags: "-m, --message-types <types>",
            description: "Alias for --messages",
        },
        {
            flags: "--dependency-strategy <strategy>",
            description: "Dependency copy strategy: file, safe-symbols",
        },
        {
            flags: "--output-module-specifiers <style>",
            description:
                "Generated relative module specifiers: js, extensionless",
        },
        {
            flags: "--registry",
            description: "Generate message registry index.ts file",
        },
        {
            flags: "--generate-message-registry",
            description: "Alias for --registry",
        },
        {
            flags: "--dry-run",
            description: "Generate into a temporary directory and print counts",
        },
        {
            flags: "--check",
            description: "Compare generated output against output directory",
        },
    ] satisfies CliOption[],
    run: async (
        args: Record<string, unknown>,
        config: ContractsPluginConfig
    ): Promise<void> => {
        const options: RunWithConfigOptions = {
            outputDir:
                args.outputDir === undefined
                    ? undefined
                    : String(args.outputDir),
            include: args.include
                ? parseIncludeMode(String(args.include))
                : undefined,
            messageTypes: readMessageTypes(args),
            dependencyStrategy: args.dependencyStrategy
                ? parseDependencyStrategy(String(args.dependencyStrategy))
                : undefined,
            outputModuleSpecifiers: args.outputModuleSpecifiers
                ? parseOutputModuleSpecifiers(
                      String(args.outputModuleSpecifiers)
                  )
                : undefined,
            generateMessageRegistry:
                args.registry === true ||
                args.generateMessageRegistry === true,
            dryRun: args.dryRun === true,
            check: args.check === true,
        };

        await runWithConfig(options, config);
    },
};
