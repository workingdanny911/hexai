import { join, relative } from "path";
import { Scanner } from "./scanner.js";
import { Parser } from "./parser.js";
import { FileGraphResolver, type FileGraph } from "./file-graph-resolver.js";
import { FileCopier } from "./file-copier.js";
import { ContextConfig } from "./context-config.js";
import { isContractSelected } from "./contract-selector.js";
import type {
    Command,
    ContractMarkerNames,
    ContractOutputSelect,
    DecoratorNames,
    DependencyStrategy,
    DomainEvent,
    MessageType,
    OutputModuleSpecifiers,
    PublicContract,
    Query,
    ResponseNamingConvention,
    TrustedDecoratorSources,
    TypeDefinition,
} from "./domain/types.js";
import { isDependencyStrategy } from "./domain/types.js";
import { type FileSystem, nodeFileSystem } from "./file-system.js";
import { type Logger, noopLogger } from "./logger.js";
import { ConfigurationError } from "./errors.js";

const DEFAULT_EXCLUDE_DEPENDENCIES = [
    "**/*.test.ts",
    "**/*.spec.ts",
    "**/*.eh.ts",
    "**/db.ts",
    "**/infra/**",
];

export interface PipelineDependencies {
    readonly scanner: Scanner;
    readonly parser: Parser;
    readonly fileGraphResolver: FileGraphResolver;
    readonly fileCopier: FileCopier;
    readonly fileSystem: FileSystem;
    readonly logger: Logger;
}

interface PipelineCreateOptions {
    contextConfig: ContextConfig;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    fileSystem?: FileSystem;
    logger?: Logger;
    excludeDependencies?: string[];
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    trustedDecoratorSources?: TrustedDecoratorSources;
    messageTypes?: MessageType[];
    includePublicContracts?: boolean;
    dependencyStrategy?: DependencyStrategy;
    outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export interface PipelineOptions {
    readonly contextName: string;
    readonly sourceDir: string;
    readonly outputDir: string;
    readonly pathAliasRewrites?: Map<string, string>;
    readonly select?: ContractOutputSelect;
    readonly removeDecorators?: boolean;
    readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export interface PipelineResult {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly publicContracts: readonly PublicContract[];
    readonly copiedFiles: string[];
}

export interface ParsedMessages {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly publicContracts: readonly PublicContract[];
    readonly typeDefinitions: readonly TypeDefinition[];
}

export class ContractsPipeline {
    private readonly messageTypes?: readonly MessageType[];
    private readonly decoratorNames?: DecoratorNames;
    private readonly contractMarkerNames?: ContractMarkerNames;
    private readonly trustedDecoratorSources?: TrustedDecoratorSources;
    private readonly includePublicContracts?: boolean;
    private readonly dependencyStrategy: DependencyStrategy;
    private readonly outputModuleSpecifiers: OutputModuleSpecifiers;

    private constructor(
        private readonly deps: PipelineDependencies,
        messageTypes?: readonly MessageType[],
        decoratorNames?: DecoratorNames,
        contractMarkerNames?: ContractMarkerNames,
        trustedDecoratorSources?: TrustedDecoratorSources,
        includePublicContracts?: boolean,
        dependencyStrategy: DependencyStrategy = "safe-symbols",
        outputModuleSpecifiers: OutputModuleSpecifiers = "js"
    ) {
        this.messageTypes = messageTypes;
        this.decoratorNames = decoratorNames;
        this.contractMarkerNames = contractMarkerNames;
        this.trustedDecoratorSources = trustedDecoratorSources;
        this.includePublicContracts = includePublicContracts;
        this.dependencyStrategy = dependencyStrategy;
        this.outputModuleSpecifiers = outputModuleSpecifiers;
    }

    static create(options: PipelineCreateOptions): ContractsPipeline {
        assertNoRemovedEntryStrategy(options);

        const fileSystem = options.fileSystem ?? nodeFileSystem;
        const logger = options.logger ?? noopLogger;
        const excludeDependencies = options.excludeDependencies ?? DEFAULT_EXCLUDE_DEPENDENCIES;
        const includePublicContracts = options.includePublicContracts ?? true;
        const dependencyStrategy = validateDependencyStrategy(
            options.dependencyStrategy
        );
        const scanner = new Scanner({
            fileSystem,
            decoratorNames: options.decoratorNames,
            contractMarkerNames: options.contractMarkerNames,
            trustedDecoratorSources: options.trustedDecoratorSources,
            messageTypes: options.messageTypes,
            includePublicContracts,
        });
        const parser = new Parser({
            decoratorNames: options.decoratorNames,
            contractMarkerNames: options.contractMarkerNames,
            trustedDecoratorSources: options.trustedDecoratorSources,
            responseNamingConventions: options.responseNamingConventions ?? options.contextConfig.responseNamingConventions,
            messageTypes: options.messageTypes,
            includePublicContracts,
        });
        const fileGraphResolver = FileGraphResolver.create({
            contextConfig: options.contextConfig,
            fileSystem,
            excludeDependencies,
        });
        const fileCopier = new FileCopier({ fileSystem });

        return new ContractsPipeline(
            {
                scanner,
                parser,
                fileGraphResolver,
                fileCopier,
                fileSystem,
                logger,
            },
            options.messageTypes,
            options.decoratorNames,
            options.contractMarkerNames,
            options.trustedDecoratorSources,
            includePublicContracts,
            dependencyStrategy,
            options.outputModuleSpecifiers ?? "js"
        );
    }

    static fromDependencies(deps: PipelineDependencies): ContractsPipeline {
        return new ContractsPipeline(deps);
    }

    async execute(options: PipelineOptions): Promise<PipelineResult> {
        const {
            contextName,
            sourceDir,
            outputDir,
            pathAliasRewrites,
            select,
            removeDecorators,
            outputModuleSpecifiers = this.outputModuleSpecifiers,
        } = options;
        const contextOutputDir = join(outputDir, contextName);

        this.deps.logger.info(`Processing context: ${contextName}`);
        this.deps.logger.debug(`  Source: ${sourceDir}`);
        this.deps.logger.debug(`  Output: ${contextOutputDir}`);

        const candidateFiles = await this.scan(sourceDir);
        const parsedMessages = await this.parse(candidateFiles, sourceDir);
        const messages = this.selectMessages(parsedMessages, select);
        const entryPoints = this.collectEntryPoints(messages);
        const fileGraph = await this.resolve(entryPoints, sourceDir);
        const responseTypesToInclude = this.collectResponseTypesToInclude(messages);
        const responseTypesToExport = this.collectResponseTypesToExport(messages);
        const publicContractsToExport = this.collectPublicContractsToExport(messages);
        const copiedFiles = await this.copy(
            fileGraph,
            sourceDir,
            contextOutputDir,
            pathAliasRewrites,
            responseTypesToExport,
            publicContractsToExport,
            responseTypesToInclude,
            removeDecorators,
            this.messageTypes,
            this.dependencyStrategy,
            select,
            outputModuleSpecifiers
        );
        await this.exportBarrel(copiedFiles, contextOutputDir, outputModuleSpecifiers);

        this.deps.logger.info(`Completed context: ${contextName} (${messages.events.length} events, ${messages.commands.length} commands, ${messages.queries.length} queries, ${messages.publicContracts.length} public contracts, ${copiedFiles.length} files)`);

        return {
            events: messages.events,
            commands: messages.commands,
            queries: messages.queries,
            publicContracts: messages.publicContracts,
            copiedFiles,
        };
    }

    private selectMessages(
        messages: ParsedMessages,
        select: ContractOutputSelect | undefined
    ): ParsedMessages {
        if (!select) {
            return messages;
        }

        return {
            events: messages.events.filter((event) =>
                isContractSelected(event, select)
            ),
            commands: messages.commands.filter((command) =>
                isContractSelected(command, select)
            ),
            queries: messages.queries.filter((query) =>
                isContractSelected(query, select)
            ),
            publicContracts: messages.publicContracts.filter((contract) =>
                isContractSelected(
                    {
                        ...contract,
                        contractType: "contract",
                    },
                    select
                )
            ),
            typeDefinitions: messages.typeDefinitions,
        };
    }

    private collectResponseTypesToExport(messages: ParsedMessages): Map<string, string[]> {
        const result = new Map<string, string[]>();
        const allMessages = [...messages.commands, ...messages.queries];

        for (const message of allMessages) {
            if (message.resultType?.kind !== "reference") continue;

            const typeName = message.resultType.name;
            const sourceFile = message.sourceFile.absolutePath;

            // Check if this type exists and is not exported
            const typeDef = messages.typeDefinitions.find(
                (t) =>
                    t.name === typeName &&
                    t.sourceFile.absolutePath === sourceFile &&
                    !t.exported
            );

            if (typeDef) {
                const existing = result.get(sourceFile) ?? [];
                if (!existing.includes(typeName)) {
                    existing.push(typeName);
                    result.set(sourceFile, existing);
                }
            }
        }

        if (result.size > 0) {
            this.deps.logger.debug(`Found ${result.size} file(s) with unexported response types`);
        }

        return result;
    }

    private collectResponseTypesToInclude(messages: ParsedMessages): Map<string, string[]> {
        const result = new Map<string, string[]>();
        const allMessages = [...messages.commands, ...messages.queries];

        for (const message of allMessages) {
            if (message.resultType?.kind !== "reference") continue;

            const typeName = message.resultType.name;
            const sourceFile = message.sourceFile.absolutePath;
            const typeDef = messages.typeDefinitions.find(
                (t) =>
                    t.name === typeName &&
                    t.sourceFile.absolutePath === sourceFile
            );

            if (!typeDef) continue;

            const existing = result.get(sourceFile) ?? [];
            if (!existing.includes(typeName)) {
                existing.push(typeName);
                result.set(sourceFile, existing);
            }
        }

        return result;
    }

    private collectPublicContractsToExport(messages: ParsedMessages): Map<string, string[]> {
        const result = new Map<string, string[]>();

        for (const contract of messages.publicContracts) {
            if (contract.exported) continue;

            const sourceFile = contract.sourceFile.absolutePath;
            const existing = result.get(sourceFile) ?? [];
            if (!existing.includes(contract.name)) {
                existing.push(contract.name);
                result.set(sourceFile, existing);
            }
        }

        if (result.size > 0) {
            this.deps.logger.debug(`Found ${result.size} file(s) with unexported public contracts`);
        }

        return result;
    }

    private collectEntryPoints(messages: ParsedMessages): string[] {
        const entryPoints = new Set<string>();

        for (const message of [
            ...messages.events,
            ...messages.commands,
            ...messages.queries,
        ]) {
            entryPoints.add(message.sourceFile.absolutePath);
        }

        for (const contract of messages.publicContracts) {
            entryPoints.add(contract.sourceFile.absolutePath);
        }

        return [...entryPoints];
    }

    async scan(sourceDir: string): Promise<string[]> {
        this.deps.logger.debug(`Scanning for decorated files in ${sourceDir}`);
        const files = await this.deps.scanner.scan(sourceDir);
        this.deps.logger.debug(`Found ${files.length} decorated file(s)`);
        return files;
    }

    async parse(files: string[], sourceRoot: string): Promise<ParsedMessages> {
        this.deps.logger.debug(`Parsing ${files.length} file(s)`);
        const events: DomainEvent[] = [];
        const commands: Command[] = [];
        const queries: Query[] = [];
        const publicContracts: PublicContract[] = [];
        const typeDefinitions: TypeDefinition[] = [];

        for (const file of files) {
            const content = await this.deps.fileSystem.readFile(file);
            const sourceFileInfo = {
                absolutePath: file,
                relativePath: relative(sourceRoot, file),
            };
            const result = this.deps.parser.parse(content, sourceFileInfo);
            events.push(...result.events);
            commands.push(...result.commands);
            queries.push(...result.queries);
            publicContracts.push(...result.publicContracts);
            typeDefinitions.push(...result.typeDefinitions);
        }

        this.deps.logger.debug(`Parsed ${events.length} event(s), ${commands.length} command(s), ${queries.length} query(s), ${publicContracts.length} public contract(s), ${typeDefinitions.length} type(s)`);
        return {
            events,
            commands,
            queries,
            publicContracts,
            typeDefinitions,
        };
    }

    async resolve(entryPoints: string[], sourceRoot: string): Promise<FileGraph> {
        this.deps.logger.debug(`Resolving dependencies for ${entryPoints.length} entry point(s)`);
        const graph = await this.deps.fileGraphResolver.buildGraph(entryPoints, sourceRoot);
        this.deps.logger.debug(`Resolved ${graph.nodes.size} file(s) in dependency graph`);
        return graph;
    }

    async copy(
        fileGraph: FileGraph,
        sourceRoot: string,
        outputDir: string,
        pathAliasRewrites?: Map<string, string>,
        responseTypesToExport?: Map<string, string[]>,
        publicContractsToExport?: Map<string, string[]>,
        responseTypesToInclude?: Map<string, string[]>,
        removeDecorators?: boolean,
        messageTypes?: readonly MessageType[],
        dependencyStrategy: DependencyStrategy = this.dependencyStrategy,
        select?: ContractOutputSelect,
        outputModuleSpecifiers: OutputModuleSpecifiers = this.outputModuleSpecifiers
    ): Promise<string[]> {
        this.deps.logger.debug(`Copying files to ${outputDir}`);
        await this.deps.fileSystem.mkdir(outputDir, { recursive: true });

        const result = await this.deps.fileCopier.copyFiles({
            sourceRoot,
            outputDir,
            fileGraph,
            pathAliasRewrites,
            responseTypesToExport,
            responseTypesToInclude,
            publicContractsToExport,
            removeDecorators,
            messageTypes,
            decoratorNames: this.decoratorNames,
            contractMarkerNames: this.contractMarkerNames,
            trustedDecoratorSources: this.trustedDecoratorSources,
            includePublicContracts: this.includePublicContracts,
            dependencyStrategy,
            select,
            outputModuleSpecifiers,
        });

        this.deps.logger.debug(`Copied ${result.copiedFiles.length} file(s)`);
        return result.copiedFiles;
    }

    async exportBarrel(
        copiedFiles: string[],
        outputDir: string,
        outputModuleSpecifiers: OutputModuleSpecifiers = this.outputModuleSpecifiers
    ): Promise<void> {
        this.deps.logger.debug(`Generating barrel export at ${outputDir}/index.ts`);
        const indexContent = this.deps.fileCopier.generateBarrelExport(
            copiedFiles,
            outputDir,
            { outputModuleSpecifiers }
        );
        await this.deps.fileSystem.writeFile(join(outputDir, "index.ts"), indexContent);
    }
}

function assertNoRemovedEntryStrategy(options: object): void {
    if (Object.prototype.hasOwnProperty.call(options, "entryStrategy")) {
        throw new ConfigurationError(
            "entryStrategy has been removed. Strict symbol entry extraction is always used."
        );
    }
}

function validateDependencyStrategy(
    dependencyStrategy: DependencyStrategy | undefined
): DependencyStrategy {
    if (dependencyStrategy === undefined) {
        return "safe-symbols";
    }

    if (isDependencyStrategy(dependencyStrategy)) {
        return dependencyStrategy;
    }

    throw new ConfigurationError(
        `Invalid dependencyStrategy: "${String(dependencyStrategy)}". Expected "file" or "safe-symbols".`
    );
}
