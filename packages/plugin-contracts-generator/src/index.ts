/**
 * Contracts Generator
 *
 * Extract Domain Events and Commands from TypeScript source code using decorators.
 *
 * @example
 * ```typescript
 * import { extract } from '@hexaijs/plugin-contracts-generator';
 *
 * const result = await extract({
 *   sourceDir: 'packages',
 *   outputDir: 'packages/contracts',
 * });
 *
 * console.log(`Extracted ${result.events.length} events and ${result.commands.length} commands`);
 * ```
 */

export type {
    SourceFile,
    TypeRef,
    PrimitiveType,
    ArrayType,
    ObjectType,
    UnionType,
    IntersectionType,
    ReferenceType,
    LiteralType,
    TupleType,
    FunctionType,
    FunctionParameter,
    Field,
    TypeDefinition,
    TypeDefinitionKind,
    EnumMember,
    EnumDefinition,
    ClassDefinition,
    ClassImport,
    Message,
    MessageBase,
    DomainEvent,
    Command,
    Dependency,
    DependencyKind,
    ImportSource,
    ExtractionResult,
    ExtractionError,
    ExtractionWarning,
    Config,
} from "./domain/types";

export {
    isPrimitiveType,
    isArrayType,
    isObjectType,
    isUnionType,
    isIntersectionType,
    isReferenceType,
    isLiteralType,
    isTupleType,
    isFunctionType,
    isDomainEvent,
    isCommand,
} from "./domain/types";

export {
    PublicEvent,
    PublicCommand,
    PublicQuery,
    type PublicEventOptions,
    type PublicCommandOptions,
    type PublicQueryOptions,
} from "./decorators";

export { Scanner, type ScannerOptions } from "./scanner";
export { Parser, type ParseResult } from "./parser";
export { FileGraphResolver } from "./file-graph-resolver";
export { FileCopier } from "./file-copier";
export { ConfigLoader, resolveContextEntries, type ContractsConfig } from "./config-loader";

export {
    MessageParserError,
    ConfigurationError,
    ConfigLoadError,
    FileSystemError,
    FileNotFoundError,
    FileReadError,
    FileWriteError,
    ParseError,
    JsonParseError,
    ResolutionError,
    ModuleResolutionError,
} from "./errors";

export {
    RegistryGenerator,
    type RegistryGeneratorOptions,
    type ContextMessages,
} from "./registry-generator";

export {
    ReexportGenerator,
    type ReexportGeneratorOptions,
    type AnalyzeOptions,
    type GenerateOptions,
    type RewrittenImport,
    type ReexportFile,
} from "./reexport-generator";

import { type FileSystem, nodeFileSystem } from "./file-system";
import { type Logger, noopLogger } from "./logger";
import { ContractsPipeline } from "./pipeline";

export type { FileSystem, FileStats } from "./file-system";
export { nodeFileSystem } from "./file-system";

export type { Logger, LogLevel, ConsoleLoggerOptions } from "./logger";
export { ConsoleLogger, noopLogger } from "./logger";

export {
    ContractsPipeline,
    type PipelineDependencies,
    type PipelineOptions,
    type PipelineResult,
    type ParsedMessages,
} from "./pipeline";

export { ContextConfig, type InputContextConfig } from "./context-config";

import { ContextConfig } from "./context-config";
import type { ResponseNamingConvention, MessageType } from "./domain/types";

export interface ProcessContextOptions {
    contextName: string;
    path: string;
    sourceDir?: string;
    outputDir: string;
    pathAliasRewrites?: Map<string, string>;
    tsconfigPath?: string;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    removeDecorators?: boolean;
    messageTypes?: MessageType[];
    fileSystem?: FileSystem;
    logger?: Logger;
}

export interface ProcessContextResult {
    events: readonly import("./domain/types").DomainEvent[];
    commands: readonly import("./domain/types").Command[];
    queries: readonly import("./domain/types").Query[];
    copiedFiles: string[];
}

export async function processContext(
    options: ProcessContextOptions
): Promise<ProcessContextResult> {
    const {
        contextName,
        path: contextPath,
        sourceDir,
        outputDir,
        pathAliasRewrites,
        tsconfigPath,
        responseNamingConventions,
        removeDecorators,
        messageTypes,
        fileSystem = nodeFileSystem,
        logger = noopLogger,
    } = options;

    const contextConfig = await ContextConfig.create(
        {
            name: contextName,
            path: contextPath,
            sourceDir,
            tsconfigPath,
            responseNamingConventions,
        },
        process.cwd(),
        fileSystem
    );

    return ContractsPipeline.create({
        contextConfig,
        responseNamingConventions,
        messageTypes,
        fileSystem,
        logger,
    }).execute({
        contextName,
        sourceDir: contextConfig.sourceDir,
        outputDir,
        pathAliasRewrites,
        removeDecorators,
    });
}

// Hexai CLI plugin integration
export { cliPlugin } from "./hexai-plugin";
