import { join, relative } from "path";
import { Scanner } from "./scanner";
import { Parser } from "./parser";
import { FileGraphResolver, type FileGraph } from "./file-graph-resolver";
import { FileCopier } from "./file-copier";
import type { DomainEvent, Command, Query, TypeDefinition, ResponseNamingConvention, MessageType } from "./domain/types";
import { type FileSystem, nodeFileSystem } from "./file-system";
import { type Logger, noopLogger } from "./logger";

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

export interface PipelineOptions {
    readonly contextName: string;
    readonly sourceDir: string;
    readonly outputDir: string;
    readonly pathAliasRewrites?: Map<string, string>;
    readonly removeDecorators?: boolean;
}

export interface PipelineResult {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly copiedFiles: string[];
}

export interface ParsedMessages {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly typeDefinitions: readonly TypeDefinition[];
}

export class ContractsPipeline {
    private readonly messageTypes?: readonly MessageType[];

    private constructor(
        private readonly deps: PipelineDependencies,
        messageTypes?: readonly MessageType[]
    ) {
        this.messageTypes = messageTypes;
    }

    static async create(options: {
        tsconfigPath?: string;
        responseNamingConventions?: readonly ResponseNamingConvention[];
        fileSystem?: FileSystem;
        logger?: Logger;
        excludeDependencies?: string[];
        messageTypes?: MessageType[];
    } = {}): Promise<ContractsPipeline> {
        const fileSystem = options.fileSystem ?? nodeFileSystem;
        const logger = options.logger ?? noopLogger;
        const excludeDependencies = options.excludeDependencies ?? DEFAULT_EXCLUDE_DEPENDENCIES;
        const scanner = new Scanner({ fileSystem, messageTypes: options.messageTypes });
        const parser = new Parser({
            responseNamingConventions: options.responseNamingConventions,
            messageTypes: options.messageTypes,
        });
        const fileGraphResolver = await FileGraphResolver.create({
            tsconfigPath: options.tsconfigPath,
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
            options.messageTypes
        );
    }

    static fromDependencies(deps: PipelineDependencies): ContractsPipeline {
        return new ContractsPipeline(deps);
    }

    async execute(options: PipelineOptions): Promise<PipelineResult> {
        const { contextName, sourceDir, outputDir, pathAliasRewrites, removeDecorators } = options;
        const contextOutputDir = join(outputDir, contextName);

        this.deps.logger.info(`Processing context: ${contextName}`);
        this.deps.logger.debug(`  Source: ${sourceDir}`);
        this.deps.logger.debug(`  Output: ${contextOutputDir}`);

        const decoratedFiles = await this.scan(sourceDir);
        const messages = await this.parse(decoratedFiles, sourceDir);
        const fileGraph = await this.resolve(decoratedFiles, sourceDir);
        const responseTypesToExport = this.collectResponseTypesToExport(messages);
        const copiedFiles = await this.copy(fileGraph, sourceDir, contextOutputDir, pathAliasRewrites, responseTypesToExport, removeDecorators, this.messageTypes);
        await this.exportBarrel(copiedFiles, contextOutputDir);

        this.deps.logger.info(`Completed context: ${contextName} (${messages.events.length} events, ${messages.commands.length} commands, ${messages.queries.length} queries, ${copiedFiles.length} files)`);

        return {
            events: messages.events,
            commands: messages.commands,
            queries: messages.queries,
            copiedFiles,
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
            typeDefinitions.push(...result.typeDefinitions);
        }

        this.deps.logger.debug(`Parsed ${events.length} event(s), ${commands.length} command(s), ${queries.length} query(s), ${typeDefinitions.length} type(s)`);
        return { events, commands, queries, typeDefinitions };
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
        removeDecorators?: boolean,
        messageTypes?: readonly MessageType[]
    ): Promise<string[]> {
        this.deps.logger.debug(`Copying files to ${outputDir}`);
        await this.deps.fileSystem.mkdir(outputDir, { recursive: true });

        const result = await this.deps.fileCopier.copyFiles({
            sourceRoot,
            outputDir,
            fileGraph,
            pathAliasRewrites,
            responseTypesToExport,
            removeDecorators,
            messageTypes,
        });

        this.deps.logger.debug(`Copied ${result.copiedFiles.length} file(s)`);
        return result.copiedFiles;
    }

    async exportBarrel(copiedFiles: string[], outputDir: string): Promise<void> {
        this.deps.logger.debug(`Generating barrel export at ${outputDir}/index.ts`);
        const indexContent = this.deps.fileCopier.generateBarrelExport(copiedFiles, outputDir);
        await this.deps.fileSystem.writeFile(join(outputDir, "index.ts"), indexContent);
    }
}
