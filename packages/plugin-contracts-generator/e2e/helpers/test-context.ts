import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomBytes } from "node:crypto";

import { processContext, ProcessContextResult, RegistryGenerator, ContextMessages } from "@/index";
import type { ResponseNamingConvention, MessageType } from "@/domain/types";

const PRODUCTION_SOURCE_DIR = join(__dirname, "..", "..", "src");

export interface RunParserOptions {
    contextName?: string;
    sourceDir?: string;
    pathAliasRewrites?: Map<string, string>;
    tsconfigPath?: string;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    messageTypes?: MessageType[];
}

export class E2ETestContext {
    private readonly fixtureName: string;
    private readonly fixtureDir: string;
    private readonly outputBaseDir: string;
    private readonly runId: string;

    constructor(fixtureName: string) {
        this.fixtureName = fixtureName;
        this.fixtureDir = join(__dirname, "..", "fixtures", fixtureName);
        this.runId = randomBytes(4).toString("hex");
        this.outputBaseDir = join(
            __dirname,
            "..",
            "output",
            `run-${this.runId}`
        );
    }

    async setup(): Promise<void> {
        if (existsSync(this.outputBaseDir)) {
            await rm(this.outputBaseDir, { recursive: true });
        }
        await mkdir(this.outputBaseDir, { recursive: true });
    }

    async teardown(): Promise<void> {
        if (existsSync(this.outputBaseDir)) {
            await rm(this.outputBaseDir, { recursive: true });
        }
    }

    getFixtureDir(): string {
        return this.fixtureDir;
    }

    getSourceDir(subPath?: string): string {
        return subPath
            ? join(this.fixtureDir, "src", subPath)
            : join(this.fixtureDir, "src");
    }

    getOutputDir(): string {
        return this.outputBaseDir;
    }

    getGeneratedDir(contextName?: string): string {
        return join(this.getOutputDir(), contextName ?? this.fixtureName);
    }

    getOutputFile(...paths: string[]): string {
        return join(this.getOutputDir(), ...paths);
    }

    /**
     * Builds the default path alias rewrites for @/decorators.
     * Can be extended with additional rewrites if provided.
     */
    buildPathAliasRewrites(
        contextName: string,
        additionalRewrites?: Map<string, string>
    ): Map<string, string> {
        const decoratorsPath = join(PRODUCTION_SOURCE_DIR, "decorators");
        const outputContextDir = join(this.getOutputDir(), contextName);
        const relativeDecoratorsPath = relative(outputContextDir, decoratorsPath);

        const rewrites = new Map<string, string>([
            ["@/decorators", relativeDecoratorsPath],
        ]);

        if (additionalRewrites) {
            for (const [key, value] of additionalRewrites) {
                rewrites.set(key, value);
            }
        }

        return rewrites;
    }

    async runParser(options?: string | RunParserOptions): Promise<ProcessContextResult> {
        // Handle backward compatibility: string argument means contextName
        const opts: RunParserOptions = typeof options === "string"
            ? { contextName: options }
            : options ?? {};

        const contextName = opts.contextName ?? this.fixtureName;
        const sourceDir = opts.sourceDir ?? this.getSourceDir();

        const pathAliasRewrites = opts.pathAliasRewrites
            ?? this.buildPathAliasRewrites(contextName);

        return processContext({
            contextName,
            sourceDir,
            outputDir: this.getOutputDir(),
            pathAliasRewrites,
            tsconfigPath: opts.tsconfigPath,
            responseNamingConventions: opts.responseNamingConventions,
            messageTypes: opts.messageTypes,
        });
    }

    /**
     * Runs the parser for multiple contexts within the same fixture.
     * Useful for testing multi-context scenarios (e.g., orders and inventory).
     */
    async runParserForContexts(
        contexts: Array<{
            contextName: string;
            sourceSubPath: string;
            pathAliasRewrites?: Map<string, string>;
        }>
    ): Promise<Map<string, ProcessContextResult>> {
        const results = new Map<string, ProcessContextResult>();

        for (const context of contexts) {
            const pathAliasRewrites = context.pathAliasRewrites
                ?? this.buildPathAliasRewrites(context.contextName);

            const result = await processContext({
                contextName: context.contextName,
                sourceDir: this.getSourceDir(context.sourceSubPath),
                outputDir: this.getOutputDir(),
                pathAliasRewrites,
            });

            results.set(context.contextName, result);
        }

        return results;
    }

    /**
     * Generates registry.ts file from parser results.
     */
    async generateRegistry(
        results: Map<string, ProcessContextResult> | ProcessContextResult,
        contextName?: string
    ): Promise<string> {
        const contextMessages: ContextMessages[] = [];

        if (results instanceof Map) {
            for (const [name, result] of results) {
                contextMessages.push({
                    contextName: name,
                    events: result.events,
                    commands: result.commands,
                    queries: result.queries,
                });
            }
        } else {
            contextMessages.push({
                contextName: contextName ?? this.fixtureName,
                events: results.events,
                commands: results.commands,
                queries: results.queries,
            });
        }

        const generator = new RegistryGenerator();
        const content = generator.generate(contextMessages);

        const registryPath = join(this.getOutputDir(), "registry.ts");
        await writeFile(registryPath, content);

        return registryPath;
    }
}
