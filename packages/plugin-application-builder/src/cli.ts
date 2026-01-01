#!/usr/bin/env node
import * as path from "path";
import { generateApplicationBuilder } from "./index";

async function main() {
    const args = process.argv.slice(2);

    // Support --context-path or default to cwd
    let contextPath = process.cwd();

    const contextPathIndex = args.indexOf("--context-path");
    if (contextPathIndex !== -1 && args[contextPathIndex + 1]) {
        contextPath = path.resolve(args[contextPathIndex + 1]);
    }

    try {
        console.log(`Generating application builder for: ${contextPath}`);
        await generateApplicationBuilder(contextPath);
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
