#!/usr/bin/env node
import * as path from "path";

import { validateOutputModuleSpecifiers } from "./config.js";
import { generateApplicationBuilder } from "./index.js";

import type { OutputModuleSpecifiers } from "./config.js";

async function main() {
    const args = process.argv.slice(2);

    // Support --context-path or default to cwd
    let contextPath = process.cwd();
    let outputModuleSpecifiers: OutputModuleSpecifiers | undefined;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];

        if (arg === "--context-path") {
            contextPath = path.resolve(
                readOptionValue(args, index, "--context-path")
            );
            index++;
        } else if (arg.startsWith("--context-path=")) {
            contextPath = path.resolve(arg.slice("--context-path=".length));
        } else if (arg === "--output-module-specifiers") {
            outputModuleSpecifiers = parseOutputModuleSpecifiers(
                readOptionValue(args, index, "--output-module-specifiers")
            );
            index++;
        } else if (arg.startsWith("--output-module-specifiers=")) {
            outputModuleSpecifiers = parseOutputModuleSpecifiers(
                arg.slice("--output-module-specifiers=".length)
            );
        }
    }

    try {
        console.log(`Generating application builder for: ${contextPath}`);
        await generateApplicationBuilder(contextPath, {
            outputModuleSpecifiers,
        });
        console.log("✓ Application builder generated successfully");
    } catch (error) {
        console.error("Error generating application builder:", error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

function parseOutputModuleSpecifiers(value: string): OutputModuleSpecifiers {
    return validateOutputModuleSpecifiers(
        value.trim().toLowerCase(),
        "--output-module-specifiers"
    );
}

function readOptionValue(
    args: string[],
    index: number,
    optionName: string
): string {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
        throw new Error(
            `${optionName} requires a value. Expected "js" or "extensionless".`
        );
    }

    return value;
}
