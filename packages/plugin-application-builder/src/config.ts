export interface RawBuildPluginConfig {
    handlers: string[];
    outputFile?: string;
    applicationBuilderImportPath: string;
}

export class BuildPluginConfig {
    public readonly handlers: string[];
    public readonly outputFile: string;
    public readonly applicationBuilderImportPath: string;

    private constructor(config: {
        handlers: string[];
        outputFile: string;
        applicationBuilderImportPath: string;
    }) {
        this.handlers = config.handlers;
        this.outputFile = config.outputFile;
        this.applicationBuilderImportPath = config.applicationBuilderImportPath;
    }

    static fromRawConfig(raw: RawBuildPluginConfig): BuildPluginConfig {
        // Validate required fields
        if (!raw.applicationBuilderImportPath) {
            throw new Error(
                "applicationBuilderImportPath is required in hexai.config.ts\n" +
                    "Example: { applicationBuilderImportPath: '@/application', ... }"
            );
        }

        if (!raw.handlers || raw.handlers.length === 0) {
            throw new Error(
                "handlers array is required and must not be empty in hexai.config.ts"
            );
        }

        // Provide defaults
        return new BuildPluginConfig({
            handlers: raw.handlers,
            outputFile:
                raw.outputFile ?? "src/.generated/application-builder.ts",
            applicationBuilderImportPath: raw.applicationBuilderImportPath,
        });
    }
}
