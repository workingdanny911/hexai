/**
 * Contracts Generator
 *
 * Extract public message contracts and general TypeScript contracts from source code.
 *
 * @example
 * ```typescript
 * import { processContext } from '@hexaijs/plugin-contracts-generator';
 *
 * const result = await processContext({
 *   contextName: 'orders',
 *   path: 'packages/orders',
 *   outputDir: 'packages/contracts',
 * });
 *
 * console.log(`Extracted ${result.events.length} events and ${result.publicContracts.length} contracts`);
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
    ContractDeclaration,
    DecoratorNames,
    PublicContractDeclarationKind,
    ContractOutputConfig,
    ContractOutputInclude,
    ContractOutputSelect,
    ContractOutputTagSelect,
    EntryStrategy,
    Message,
    MessageType,
    MessageBase,
    DomainEvent,
    Command,
    Query,
    Dependency,
    DependencyKind,
    ImportSource,
    ExtractionResult,
    ExtractionError,
    ExtractionWarning,
    Config,
    ContractMarkerNames,
    TrustedDecoratorSources,
} from "./domain/types.js";

export type PublicContract = import("./domain/types.js").PublicContract;

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
    isQuery,
} from "./domain/types.js";

export {
    Contract,
    ContractEvent,
    ContractCommand,
    ContractQuery,
    PublicContract,
    PublicEvent,
    PublicCommand,
    PublicQuery,
    type BuiltInContractKind,
    type ContractBaseOptions,
    type ContractEventOptions,
    type ContractCommandOptions,
    type ContractKind,
    type ContractOptions,
    type ContractQueryOptions,
    type ContractVisibility,
    type MessageContractKind,
    type PublicContractOptions,
    type PublicEventOptions,
    type PublicCommandOptions,
    type PublicQueryOptions,
} from "@hexaijs/contracts/decorators";

export { Scanner, type ScannerOptions } from "./scanner.js";
export { Parser, type ParseResult } from "./parser.js";
export { FileGraphResolver } from "./file-graph-resolver.js";
export { FileCopier } from "./file-copier.js";
export { ConfigLoader, resolveContextEntries, type ContractsConfig } from "./config-loader.js";

export {
    MessageParserError,
    BoundaryViolationError,
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
} from "./errors.js";

export {
    RegistryGenerator,
    type RegistryGeneratorOptions,
    type ContextMessages,
} from "./registry-generator.js";

export {
    ReexportGenerator,
    type ReexportGeneratorOptions,
    type AnalyzeOptions,
    type GenerateOptions,
    type RewrittenImport,
    type ReexportFile,
} from "./reexport-generator.js";

import { type FileSystem, nodeFileSystem } from "./file-system.js";
import { type Logger, noopLogger } from "./logger.js";
import { ContractsPipeline } from "./pipeline.js";

export type { FileSystem, FileStats } from "./file-system.js";
export { nodeFileSystem } from "./file-system.js";

export type { Logger, LogLevel, ConsoleLoggerOptions } from "./logger.js";
export { ConsoleLogger, noopLogger } from "./logger.js";

export {
    ContractsPipeline,
    type PipelineDependencies,
    type PipelineOptions,
    type PipelineResult,
    type ParsedMessages,
} from "./pipeline.js";

export { ContextConfig, type InputContextConfig } from "./context-config.js";

import { ContextConfig } from "./context-config.js";
import type {
    ContractMarkerNames,
    DecoratorNames,
    EntryStrategy,
    MessageType,
    ResponseNamingConvention,
    TrustedDecoratorSources,
} from "./domain/types.js";

export interface ProcessContextOptions {
    contextName: string;
    path: string;
    sourceDir?: string;
    outputDir: string;
    pathAliasRewrites?: Map<string, string>;
    tsconfigPath?: string;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    trustedDecoratorSources?: TrustedDecoratorSources;
    removeDecorators?: boolean;
    messageTypes?: MessageType[];
    includePublicContracts?: boolean;
    entryStrategy?: EntryStrategy;
    fileSystem?: FileSystem;
    logger?: Logger;
}

export interface ProcessContextResult {
    events: readonly import("./domain/types.js").DomainEvent[];
    commands: readonly import("./domain/types.js").Command[];
    queries: readonly import("./domain/types.js").Query[];
    publicContracts: readonly import("./domain/types.js").PublicContract[];
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
        decoratorNames,
        contractMarkerNames,
        trustedDecoratorSources,
        removeDecorators,
        messageTypes,
        includePublicContracts,
        entryStrategy,
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
        decoratorNames,
        contractMarkerNames,
        trustedDecoratorSources,
        messageTypes,
        includePublicContracts,
        entryStrategy,
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
export { cliPlugin } from "./hexai-plugin.js";
