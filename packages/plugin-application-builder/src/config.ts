export type OutputModuleSpecifiers = "js" | "extensionless";

export const DEFAULT_OUTPUT_MODULE_SPECIFIERS: OutputModuleSpecifiers = "js";

const VALID_OUTPUT_MODULE_SPECIFIERS: readonly OutputModuleSpecifiers[] = [
    "js",
    "extensionless",
];

export interface RawBuildPluginConfig {
    handlers: string[];
    outputFile?: string;
    applicationBuilderImportPath: string;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export interface BuildPluginConfigOverrides {
    outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export class BuildPluginConfig {
    public readonly handlers: string[];
    public readonly outputFile: string;
    public readonly applicationBuilderImportPath: string;
    public readonly outputModuleSpecifiers: OutputModuleSpecifiers;

    private constructor(config: {
        handlers: string[];
        outputFile: string;
        applicationBuilderImportPath: string;
        outputModuleSpecifiers: OutputModuleSpecifiers;
    }) {
        this.handlers = config.handlers;
        this.outputFile = config.outputFile;
        this.applicationBuilderImportPath = config.applicationBuilderImportPath;
        this.outputModuleSpecifiers = config.outputModuleSpecifiers;
    }

    static fromRawConfig(
        raw: RawBuildPluginConfig,
        overrides: BuildPluginConfigOverrides = {}
    ): BuildPluginConfig {
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

        const configOutputModuleSpecifiers = validateOutputModuleSpecifiers(
            raw.outputModuleSpecifiers
        );
        const overrideOutputModuleSpecifiers =
            validateOptionalOutputModuleSpecifiers(
                overrides.outputModuleSpecifiers,
                "outputModuleSpecifiers"
            );

        // Provide defaults
        return new BuildPluginConfig({
            handlers: raw.handlers,
            outputFile:
                raw.outputFile ?? "src/.generated/application-builder.ts",
            applicationBuilderImportPath: raw.applicationBuilderImportPath,
            outputModuleSpecifiers:
                overrideOutputModuleSpecifiers ?? configOutputModuleSpecifiers,
        });
    }
}

export function validateOutputModuleSpecifiers(
    outputModuleSpecifiers: unknown,
    path = "outputModuleSpecifiers"
): OutputModuleSpecifiers {
    if (outputModuleSpecifiers === undefined) {
        return DEFAULT_OUTPUT_MODULE_SPECIFIERS;
    }

    if (isOutputModuleSpecifiers(outputModuleSpecifiers)) {
        return outputModuleSpecifiers;
    }

    throw new Error(
        `Invalid ${path}: "${String(outputModuleSpecifiers)}". Expected "js" or "extensionless".`
    );
}

function validateOptionalOutputModuleSpecifiers(
    outputModuleSpecifiers: unknown,
    path: string
): OutputModuleSpecifiers | undefined {
    if (outputModuleSpecifiers === undefined) {
        return undefined;
    }

    return validateOutputModuleSpecifiers(outputModuleSpecifiers, path);
}

function isOutputModuleSpecifiers(
    value: unknown
): value is OutputModuleSpecifiers {
    return (
        typeof value === "string" &&
        VALID_OUTPUT_MODULE_SPECIFIERS.includes(value as OutputModuleSpecifiers)
    );
}
