import type { HexaiCliPlugin, CliOption } from "@hexaijs/cli";
import {
    runWithConfig,
    ContractsPluginConfig,
    RunWithConfigOptions,
} from "./cli";
import type { MessageType } from "./domain/types";

const VALID_MESSAGE_TYPES: MessageType[] = ["event", "command", "query"];

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
            required: true,
        },
        {
            flags: "-m, --message-types <types>",
            description:
                "Filter message types (comma-separated: event,command,query)",
        },
        {
            flags: "--generate-message-registry",
            description: "Generate message registry index.ts file",
        },
    ] satisfies CliOption[],
    run: async (
        args: Record<string, unknown>,
        config: ContractsPluginConfig
    ): Promise<void> => {
        const options: RunWithConfigOptions = {
            outputDir: String(args.outputDir),
            messageTypes: args.messageTypes
                ? parseMessageTypes(String(args.messageTypes))
                : undefined,
            generateMessageRegistry: args.generateMessageRegistry === true,
        };

        await runWithConfig(options, config);
    },
};
