import * as path from "path";

import { ApplicationBuilderGenerator } from "./application-builder-generator.js";
import { loadConfig } from "./config-loader.js";

import type { OutputModuleSpecifiers } from "./config.js";

export interface GenerateApplicationBuilderOptions {
    configFile?: string;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
}

// Re-export types for external use
export type {
    HandlerMetadata,
    CommandHandlerMetadata,
    EventHandlerMetadata,
} from "./types.js";
export { HandlerMetadataExtractor } from "./metadata-extractor.js";

export async function generateApplicationBuilder(
    contextPath: string,
    options: GenerateApplicationBuilderOptions = {}
): Promise<void> {
    const configFile = options.configFile ?? "hexai.config.ts";

    const configPath = path.join(contextPath, configFile);
    const config = await loadConfig(configPath, {
        outputModuleSpecifiers: options.outputModuleSpecifiers,
    });

    const generator = new ApplicationBuilderGenerator(contextPath, config);
    await generator.generate();
}
