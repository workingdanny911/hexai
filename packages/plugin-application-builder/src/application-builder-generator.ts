import * as fs from "fs";
import * as path from "path";
import { glob } from "glob";
import { BuildPluginConfig } from "./config";
import { HandlerMetadataExtractor } from "./metadata-extractor";
import { ApplicationCodeGenerator } from "./code-generator";

/**
 * Orchestrates the application builder generation process
 */
export class ApplicationBuilderGenerator {
    private metadataExtractor: HandlerMetadataExtractor;
    private codeGenerator: ApplicationCodeGenerator;

    constructor(
        private contextPath: string,
        private config: BuildPluginConfig
    ) {
        this.metadataExtractor = new HandlerMetadataExtractor(
            contextPath,
            config.outputFile
        );
        this.codeGenerator = new ApplicationCodeGenerator(config);
    }

    async generate(): Promise<void> {
        const handlerFiles = await this.scanHandlerFiles();
        const handlers = this.metadataExtractor.extractHandlersMetadata(handlerFiles);
        const code = this.codeGenerator.generateCode(handlers);
        this.writeToFile(code);
    }

    private async scanHandlerFiles(): Promise<string[]> {
        const allFiles: string[] = [];

        for (const pattern of this.config.handlers) {
            const files = await glob(pattern, {
                cwd: this.contextPath,
                absolute: true,
            });
            allFiles.push(...files);
        }

        return allFiles.sort();
    }

    private writeToFile(code: string): void {
        const outputFile = path.join(this.contextPath, this.config.outputFile);
        const outputDir = path.dirname(outputFile);

        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputFile, code, "utf-8");
    }
}
