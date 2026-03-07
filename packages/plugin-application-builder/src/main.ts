import * as path from "path";
import { ApplicationBuilderGenerator } from "./application-builder-generator.js";
import { loadConfig } from "./config-loader.js";

// Re-export types for external use
export type {
    HandlerMetadata,
    CommandHandlerMetadata,
    EventHandlerMetadata,
} from "./types.js";
export { HandlerMetadataExtractor } from "./metadata-extractor.js";

export async function generateApplicationBuilder(
    contextPath: string,
    options: {
        configFile?: string;
    } = {}
): Promise<void> {
    let configFile = "hexai.config.ts";
    if (options.configFile) {
        configFile = options.configFile;
    }

    const configPath = path.join(contextPath, configFile);
    const config = await loadConfig(configPath);

    const generator = new ApplicationBuilderGenerator(contextPath, config);
    await generator.generate();
}
