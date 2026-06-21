import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { FileCopier } from "./file-copier.js";
import { FileGraphResolver } from "./file-graph-resolver.js";
import { ContextConfig } from "./context-config.js";
import { UnsafeDependencySliceError } from "./errors.js";

import type { CopyOptions } from "./file-copier.js";

type BarrelExportOptions = {
    readonly outputModuleSpecifiers?: "js" | "extensionless";
};

function createTestContextConfig(sourceDir: string): ContextConfig {
    return ContextConfig.createSync("test-context", sourceDir);
}

async function copySingleEntry(
    sourceFile: string,
    sourceRoot: string,
    outputDir: string,
    options: Partial<
        Omit<CopyOptions, "sourceRoot" | "outputDir" | "fileGraph">
    > = {}
): Promise<string> {
    const resolver = FileGraphResolver.create({
        contextConfig: createTestContextConfig(sourceRoot),
    });
    const fileGraph = await resolver.buildGraph([sourceFile], sourceRoot);
    const copier = new FileCopier();

    await copier.copyFiles({
        sourceRoot,
        outputDir,
        fileGraph,
        ...options,
    });

    return fs.readFileSync(
        path.join(outputDir, path.relative(sourceRoot, sourceFile)),
        "utf-8"
    );
}

async function expectUnsafeDependencySliceError(
    promise: Promise<unknown>,
    expected: {
        readonly filePath: string;
        readonly reason: string;
    }
): Promise<void> {
    await expect(promise).rejects.toThrow(UnsafeDependencySliceError);
    await expect(promise).rejects.toMatchObject({
        filePath: expected.filePath,
        reason: expect.stringContaining(expected.reason),
    });
}

describe("FileCopier", () => {
    const fixtureRoot = path.resolve(
        __dirname,
        "../e2e/fixtures/module-structure/src"
    );

    let outputDir: string;

    beforeEach(() => {
        const runId = randomUUID().slice(0, 8);
        outputDir = path.resolve(__dirname, `../e2e/output/run-${runId}`);
        fs.mkdirSync(outputDir, { recursive: true });
    });

    afterEach(() => {
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
    });

    describe("basic file copying", () => {
        it("should copy all files from the file graph to the output directory", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                fixtureRoot
            );

            const copier = new FileCopier();

            const result = await copier.copyFiles({
                sourceRoot: fixtureRoot,
                outputDir,
                fileGraph,
            });

            expect(result.copiedFiles).toHaveLength(4);

            const expectedFiles = [
                "commands-but-different-filename.ts",
                "foo.validator.ts",
                "bar.validator.ts",
                "is-empty.ts",
            ];

            for (const fileName of expectedFiles) {
                const outputPath = path.join(outputDir, fileName);
                expect(fs.existsSync(outputPath)).toBe(true);
                expect(result.copiedFiles).toContain(outputPath);
            }
        });
    });

    describe("relative path preservation", () => {
        it("should preserve relative imports like ./foo.validator", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                fixtureRoot
            );
            const copier = new FileCopier();

            await copier.copyFiles({
                sourceRoot: fixtureRoot,
                outputDir,
                fileGraph,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "commands-but-different-filename.ts"),
                "utf-8"
            );
            expect(copiedContent).toContain("./foo.validator");
            expect(copiedContent).toContain("./bar.validator");
        });
    });

    describe("path alias transformation", () => {
        it("should transform path aliases using pathAliasRewrites", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                fixtureRoot
            );
            const copier = new FileCopier();

            const pathAliasRewrites = new Map<string, string>([
                ["@/decorators", "@libera/decorators"],
            ]);

            const result = await copier.copyFiles({
                sourceRoot: fixtureRoot,
                outputDir,
                fileGraph,
                pathAliasRewrites,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "commands-but-different-filename.ts"),
                "utf-8"
            );
            expect(copiedContent).not.toContain("@/decorators");
            expect(copiedContent).toContain("@libera/decorators");

            const rewritten = result.rewrittenImports.get(
                path.join(outputDir, "commands-but-different-filename.ts")
            );
            expect(rewritten).toContain("@/decorators → @libera/decorators");
        });
    });

    describe("barrel export generation", () => {
        it("should generate NodeNext-safe .js barrel exports by default", async () => {
            const copier = new FileCopier();

            const copiedFiles = [
                path.join(outputDir, "events.ts"),
                path.join(outputDir, "nested/is-empty.ts"),
            ];

            const indexContent = copier.generateBarrelExport(
                copiedFiles,
                outputDir
            );

            expect(indexContent.split("\n")).toEqual([
                "export * from './events.js'",
                "export * from './nested/is-empty.js'",
            ]);
        });

        it("should generate barrel export for copied files", async () => {
            const copier = new FileCopier();

            const copiedFiles = [
                path.join(outputDir, "commands-but-different-filename.ts"),
                path.join(outputDir, "foo.validator.ts"),
                path.join(outputDir, "bar.validator.ts"),
                path.join(outputDir, "is-empty.ts"),
            ];

            const indexContent = copier.generateBarrelExport(
                copiedFiles,
                outputDir
            );

            expect(indexContent).toContain(
                "export * from './commands-but-different-filename.js'"
            );
            expect(indexContent).toContain("export * from './foo.validator.js'");
            expect(indexContent).toContain("export * from './bar.validator.js'");
            expect(indexContent).toContain("export * from './is-empty.js'");
        });

        it("should generate exports in order of copiedFiles array", async () => {
            const copier = new FileCopier();

            const copiedFiles = [
                path.join(outputDir, "commands-but-different-filename.ts"),
                path.join(outputDir, "foo.validator.ts"),
            ];

            const indexContent = copier.generateBarrelExport(
                copiedFiles,
                outputDir
            );
            const lines = indexContent.split("\n");

            expect(lines[0]).toContain("commands-but-different-filename");
            expect(lines[1]).toContain("foo.validator");
        });

        it("should handle nested paths correctly", async () => {
            const copier = new FileCopier();

            const copiedFiles = [
                path.join(outputDir, "commands-but-different-filename.ts"),
                path.join(outputDir, "nested/is-empty.ts"),
            ];

            const indexContent = copier.generateBarrelExport(
                copiedFiles,
                outputDir
            );

            expect(indexContent).toContain(
                "export * from './commands-but-different-filename.js'"
            );
            expect(indexContent).toContain("export * from './nested/is-empty.js'");
        });

        it("should support legacy extensionless barrel exports when requested", async () => {
            const copier = new FileCopier();
            const generateBarrelExport = copier.generateBarrelExport.bind(
                copier
            ) as (
                copiedFiles: string[],
                outputDir: string,
                options?: BarrelExportOptions
            ) => string;

            const copiedFiles = [
                path.join(outputDir, "events.ts"),
                path.join(outputDir, "nested/is-empty.ts"),
            ];

            const indexContent = generateBarrelExport(copiedFiles, outputDir, {
                outputModuleSpecifiers: "extensionless",
            });

            expect(indexContent.split("\n")).toEqual([
                "export * from './events'",
                "export * from './nested/is-empty'",
            ]);
        });

        it("should not duplicate exports for same file", async () => {
            const copier = new FileCopier();

            // Each file should only be in copiedFiles once
            const copiedFiles = [
                path.join(outputDir, "commands-but-different-filename.ts"),
                path.join(outputDir, "is-empty.ts"),
            ];

            const indexContent = copier.generateBarrelExport(
                copiedFiles,
                outputDir
            );

            // is-empty should appear only once
            const isEmptyMatches = indexContent.match(/is-empty/g);
            expect(isEmptyMatches?.length).toBe(1);
        });
    });

    describe("decorator removal", () => {
        const decoratorFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/decorator-removal/src"
        );

        it("should remove @PublicCommand decorator and its import", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                decoratorFixtureRoot,
                "command-with-decorator.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                decoratorFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: decoratorFixtureRoot,
                outputDir,
                fileGraph,
                removeDecorators: true,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "command-with-decorator.ts"),
                "utf-8"
            );

            // Should NOT contain decorator
            expect(copiedContent).not.toContain("@PublicCommand()");
            // Should NOT contain import from plugin-contracts-generator
            expect(copiedContent).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            // Should still contain the class
            expect(copiedContent).toContain("export class PlaceOrderCommand");
            // Should still contain other imports
            expect(copiedContent).toContain("@hexaijs/core");
        });

        it("should remove @PublicEvent decorator and its import", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                decoratorFixtureRoot,
                "event-with-decorator.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                decoratorFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: decoratorFixtureRoot,
                outputDir,
                fileGraph,
                removeDecorators: true,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "event-with-decorator.ts"),
                "utf-8"
            );

            expect(copiedContent).not.toContain("@PublicEvent()");
            expect(copiedContent).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            expect(copiedContent).toContain("export class OrderPlaced");
        });

        it("should remove both PublicCommand and PublicEvent from mixed imports", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                decoratorFixtureRoot,
                "mixed-imports.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                decoratorFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: decoratorFixtureRoot,
                outputDir,
                fileGraph,
                removeDecorators: true,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "mixed-imports.ts"),
                "utf-8"
            );

            expect(copiedContent).not.toContain("@PublicCommand()");
            expect(copiedContent).not.toContain("@PublicEvent()");
            expect(copiedContent).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            expect(copiedContent).toContain("export class CreateUserCommand");
            expect(copiedContent).toContain("export class UserCreated");
        });

        it("should keep other decorators when removing PublicCommand", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                decoratorFixtureRoot,
                "multiple-decorators.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                decoratorFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: decoratorFixtureRoot,
                outputDir,
                fileGraph,
                removeDecorators: true,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "multiple-decorators.ts"),
                "utf-8"
            );

            expect(copiedContent).not.toContain("@PublicCommand()");
            expect(copiedContent).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            // Should keep @Injectable decorator
            expect(copiedContent).toContain("@Injectable()");
            expect(copiedContent).toContain("@nestjs/common");
        });

        it("should not remove decorators when removeDecorators is false", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                decoratorFixtureRoot,
                "command-with-decorator.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                decoratorFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: decoratorFixtureRoot,
                outputDir,
                fileGraph,
                removeDecorators: false,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "command-with-decorator.ts"),
                "utf-8"
            );

            // Should still contain decorator when disabled
            expect(copiedContent).toContain("@PublicCommand()");
            expect(copiedContent).toContain(
                "@hexaijs/plugin-contracts-generator"
            );
        });

        it("should remove PublicContract and configured contract decorators", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "contracts.ts");
            fs.writeFileSync(
                sourceFile,
                `import { PublicContract, PublicCommand, PublicEvent, PublicQuery, PublicEventOptions } from "@hexaijs/contracts";

/** @PublicContract() */
export interface PublicProfile {
    id: string;
}

@PublicContract()
export class PublicProjection {}

@SharedContract()
export class SharedProjection {}

@ContractCommand()
export class CreateUserCommand {}
`
            );

            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(testDir),
            });
            const fileGraph = await resolver.buildGraph([sourceFile], testDir);

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: testDir,
                outputDir,
                fileGraph,
                removeDecorators: true,
                decoratorNames: {
                    command: "ContractCommand",
                },
                contractMarkerNames: {
                    contract: "SharedContract",
                },
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "contracts.ts"),
                "utf-8"
            );

            expect(copiedContent).not.toContain("@PublicContract");
            expect(copiedContent).not.toContain("@SharedContract");
            expect(copiedContent).not.toContain("@ContractCommand");
            expect(copiedContent).not.toContain("PublicCommand");
            expect(copiedContent).not.toMatch(/\bPublicEvent\b/);
            expect(copiedContent).not.toContain("PublicQuery");
            expect(copiedContent).toContain("PublicEventOptions");
            expect(copiedContent).toContain(
                "@hexaijs/contracts"
            );
        });

        it("should remove direct ContractCommand decorator and import", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractCommand } from "@hexaijs/contracts";

@ContractCommand()
export class CreateUserCommand {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@ContractCommand");
            expect(copiedContent).not.toContain("ContractCommand");
            expect(copiedContent).not.toContain("@hexaijs/contracts");
            expect(copiedContent).toContain("export class CreateUserCommand");
        });

        it("should remove named alias decorator imports when only decorators used them", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractCommand as CommandMarker, ContractEvent } from "@hexaijs/contracts";

@CommandMarker()
export class CreateUserCommand {}

@ContractEvent()
export class UserCreated {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@CommandMarker");
            expect(copiedContent).not.toContain("@ContractEvent");
            expect(copiedContent).not.toContain("CommandMarker");
            expect(copiedContent).not.toContain("ContractEvent");
            expect(copiedContent).not.toContain("@hexaijs/contracts");
        });

        it("should keep named alias decorator imports when the local alias is still used", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractCommand as CommandMarker } from "@hexaijs/contracts";

@CommandMarker()
export class CreateUserCommand {}

export const markerReference = CommandMarker;
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@CommandMarker");
            expect(copiedContent).toContain(
                "ContractCommand as CommandMarker"
            );
            expect(copiedContent).toContain(
                "export const markerReference = CommandMarker"
            );
        });

        it("should remove generic Contract decorators and imports", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { Contract } from "@hexaijs/contracts";

@Contract({ kind: "query" })
export class FindUserQuery {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@Contract");
            expect(copiedContent).not.toContain("Contract");
            expect(copiedContent).not.toContain("@hexaijs/contracts");
            expect(copiedContent).toContain("export class FindUserQuery");
        });

        it("should remove decorators imported from configured trusted sources", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractCommand } from "@app/contracts";

@ContractCommand()
export class CreateUserCommand {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                {
                    removeDecorators: true,
                    trustedDecoratorSources: ["@app/contracts"],
                }
            );

            expect(copiedContent).not.toContain("@ContractCommand");
            expect(copiedContent).not.toContain("@app/contracts");
            expect(copiedContent).toContain("export class CreateUserCommand");
        });

        it("should preserve non-decorator specifiers in legacy mixed imports", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "event.ts");
            fs.writeFileSync(
                sourceFile,
                `import { PublicEvent, PublicEventOptions } from "@hexaijs/contracts";

const options: PublicEventOptions = {};

@PublicEvent(options)
export class UserCreated {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@PublicEvent");
            expect(copiedContent).not.toMatch(/\bPublicEvent,/);
            expect(copiedContent).toContain("PublicEventOptions");
            expect(copiedContent).toContain("@hexaijs/contracts");
        });

        it("should remove comment marker lines with options", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "contracts.ts");
            fs.writeFileSync(
                sourceFile,
                `// @Contract({ kind: "snapshot", visibility: "internal" })
export interface UserSnapshot {}

/** @PublicContract({ kind: "projection", tags: ["read"] }) */
export type UserProjection = {
    id: string;
};
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).not.toContain("@Contract");
            expect(copiedContent).not.toContain("@PublicContract");
            expect(copiedContent).toContain("export interface UserSnapshot");
            expect(copiedContent).toContain("export type UserProjection");
        });

        it("should preserve prose comments that mention Contract marker names", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "contracts.ts");
            fs.writeFileSync(
                sourceFile,
                `/**
 * @Contract is a documentation tag here, not a marker call.
 */
export interface ContractDocs {}

// @Contract({ kind: "snapshot" })
export interface UserSnapshot {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).toContain(
                "@Contract is a documentation tag here"
            );
            expect(copiedContent).not.toContain('@Contract({ kind: "snapshot" })');
            expect(copiedContent).toContain("export interface ContractDocs");
            expect(copiedContent).toContain("export interface UserSnapshot");
        });

        it("should preserve same-name decorators imported from untrusted sources", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractCommand } from "other-contracts";

@ContractCommand()
export class CreateUserCommand {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                { removeDecorators: true }
            );

            expect(copiedContent).toContain(
                'import { ContractCommand } from "other-contracts"'
            );
            expect(copiedContent).toContain("@ContractCommand()");
            expect(copiedContent).toContain("export class CreateUserCommand");
        });
    });

    describe("symbols entry strategy", () => {
        it("should extract ContractCommand, generic custom Contract, and comment marker declarations", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "contracts.ts");
            fs.writeFileSync(
                sourceFile,
                `import { Contract, ContractCommand } from "@hexaijs/contracts";

@ContractCommand()
export class CreateUserCommand {}

@Contract({ kind: "snapshot" })
class UserSnapshot {}

// @Contract({ kind: "projection" })
interface UserProjection {}

class InternalHelper {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                {
                    entryStrategy: "symbols",
                    includePublicContracts: true,
                }
            );

            expect(copiedContent).toContain("CreateUserCommand");
            expect(copiedContent).toContain("export class UserSnapshot");
            expect(copiedContent).toContain("export interface UserProjection");
            expect(copiedContent).not.toContain("InternalHelper");
        });

        it("should treat generic Contract message kinds as selected messages", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "queries.ts");
            fs.writeFileSync(
                sourceFile,
                `import { Contract } from "@hexaijs/contracts";

@Contract({ kind: "query" })
export class FindUserQuery {}

@Contract({ kind: "snapshot" })
export class UserSnapshot {}
`
            );

            const copiedContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                {
                    entryStrategy: "symbols",
                    messageTypes: ["query"],
                    includePublicContracts: false,
                }
            );

            expect(copiedContent).toContain("FindUserQuery");
            expect(copiedContent).not.toContain("UserSnapshot");
        });

        it("should copy full dependency files by default", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import { UsedShape, UnusedShape } from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly shape!: UsedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "shapes.ts"),
                `export interface UsedShape {
    readonly id: string;
}

export interface UnusedShape {
    readonly unused: string;
}
`
            );

            await copySingleEntry(sourceFile, testDir, outputDir, {
                entryStrategy: "symbols",
            });

            const dependencyContent = fs.readFileSync(
                path.join(outputDir, "shapes.ts"),
                "utf-8"
            );

            expect(dependencyContent).toContain("UsedShape");
            expect(dependencyContent).toContain("UnusedShape");
        });

        it("should slice dependency files when dependencyStrategy is safe-symbols", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import { UsedShape, UnusedShape } from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly shape!: UsedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "shapes.ts"),
                `export interface UsedShape {
    readonly id: string;
}

export interface UnusedShape {
    readonly unused: string;
}
`
            );

            await copySingleEntry(sourceFile, testDir, outputDir, {
                entryStrategy: "symbols",
                dependencyStrategy: "safe-symbols",
            });

            const dependencyContent = fs.readFileSync(
                path.join(outputDir, "shapes.ts"),
                "utf-8"
            );

            expect(dependencyContent).toContain("UsedShape");
            expect(dependencyContent).not.toContain("UnusedShape");
        });

        it("should reject local import types in extracted entries when dependencyStrategy is safe-symbols", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";

@ContractQuery()
export class FindUserQuery {
    readonly nested!: import("./nested.js").NestedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "nested.ts"),
                `export interface NestedShape {
    readonly id: string;
}
`
            );

            await expectUnsafeDependencySliceError(
                copySingleEntry(sourceFile, testDir, outputDir, {
                    entryStrategy: "symbols",
                    dependencyStrategy: "safe-symbols",
                }),
                {
                    filePath: sourceFile,
                    reason: "local import type: ./nested.js",
                }
            );
        });

        it("should preserve local import types in extracted entries when dependencyStrategy is file", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";

@ContractQuery()
export class FindUserQuery {
    readonly nested!: import("./nested.js").NestedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "nested.ts"),
                `export interface NestedShape {
    readonly id: string;
}
`
            );

            const entryContent = await copySingleEntry(
                sourceFile,
                testDir,
                outputDir,
                {
                    entryStrategy: "symbols",
                    dependencyStrategy: "file",
                }
            );

            expect(entryContent).toContain('import("./nested.js").NestedShape');
        });

        async function expectUnsafeDependencySlice(
            dependencyContent: string,
            expectedReason: string,
            options: {
                readonly entryImport?: string;
                readonly entryPropertyType?: string;
                readonly extraFiles?: Readonly<Record<string, string>>;
            } = {}
        ): Promise<void> {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            const entryImport = options.entryImport ?? "{ UsedShape }";
            const entryPropertyType = options.entryPropertyType ?? "UsedShape";

            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import ${entryImport} from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly shape!: ${entryPropertyType};
}
`
            );
            fs.writeFileSync(path.join(testDir, "shapes.ts"), dependencyContent);

            for (const [fileName, content] of Object.entries(
                options.extraFiles ?? {}
            )) {
                fs.writeFileSync(path.join(testDir, fileName), content);
            }

            await expectUnsafeDependencySliceError(
                copySingleEntry(sourceFile, testDir, outputDir, {
                    entryStrategy: "symbols",
                    dependencyStrategy: "safe-symbols",
                }),
                {
                    filePath: path.join(testDir, "shapes.ts"),
                    reason: expectedReason,
                }
            );
        }

        it.each([
            {
                name: "side-effect import",
                reason: "side-effect import",
                dependency: `import "./setup.js";

export interface UsedShape {
    readonly id: string;
}
`,
                extraFiles: {
                    "setup.ts": "export const setupLoaded = true;\n",
                },
            },
            {
                name: "export declaration",
                reason: "export declaration",
                dependency: `export { OtherShape } from "./other-shape.js";

export interface UsedShape {
    readonly id: string;
}
`,
                extraFiles: {
                    "other-shape.ts": "export interface OtherShape {}\n",
                },
            },
            {
                name: "dynamic import",
                reason: "dynamic import",
                dependency: `export interface UsedShape {
    readonly id: string;
}

export async function loadLazyShape() {
    return import("./lazy-shape.js");
}
`,
            },
            {
                name: "local import type",
                reason: "local import type",
                dependency: `export interface UsedShape {
    readonly nested: import("./nested.js").NestedShape;
}
`,
                extraFiles: {
                    "nested.ts": `export interface NestedShape {
    readonly id: string;
}
`,
                },
            },
            {
                name: "unsafe top-level variable initializer",
                reason: "unsafe top-level variable initializer",
                dependency: `const token = createToken();

function createToken(): string {
    return "token";
}

export interface UsedShape {
    readonly id: typeof token;
}
`,
            },
            {
                name: "assignment top-level variable initializer",
                reason: "unsafe top-level variable initializer",
                dependency: `const touched = (globalThis.__shapeTouched = true);

export interface UsedShape {
    readonly id: string;
}
`,
            },
            {
                name: "update top-level variable initializer",
                reason: "unsafe top-level variable initializer",
                dependency: `let mutationCounter = 0;
const touched = ++mutationCounter;

export interface UsedShape {
    readonly id: string;
}
`,
            },
            {
                name: "delete top-level variable initializer",
                reason: "unsafe top-level variable initializer",
                dependency: `const touched = delete globalThis.__shapeTouched;

export interface UsedShape {
    readonly id: string;
}
`,
            },
            {
                name: "class static block",
                reason: "class static block",
                dependency: `export class UsedShape {
    static {
        configureShape();
    }

    readonly id!: string;
}

function configureShape(): void {}
`,
            },
            {
                name: "class static member initializer",
                reason: "class static member initializer",
                dependency: `export interface UsedShape {
    readonly id: string;
}

class UnusedShapeRegistration {
    static token = registerShape();
}

function registerShape(): string {
    return "token";
}
`,
            },
            {
                name: "class computed static member name",
                reason: "class computed member name",
                dependency: `export interface UsedShape {
    readonly id: string;
}

class UnusedShapeRegistration {
    static [registerShape()](): void {}
}

function registerShape(): string {
    return "token";
}
`,
            },
            {
                name: "class heritage expression",
                reason: "class heritage/extends",
                dependency: `class BaseShape {}

function makeBase(): typeof BaseShape {
    return BaseShape;
}

class UnusedShapeRegistration extends makeBase() {}

export interface UsedShape {
    readonly id: string;
}
`,
            },
            {
                name: "class computed member name",
                reason: "class computed member name",
                dependency: `export interface UsedShape {
    readonly id: string;
}

class UnusedShapeRegistration {
    [registerShape()](): void {}
}

function registerShape(): string {
    return "token";
}
`,
            },
            {
                name: "class decorator",
                reason: "class decorator",
                dependency: `function shapeMarker(): ClassDecorator {
    return () => {};
}

@shapeMarker()
export class UsedShape {}
`,
            },
            {
                name: "class member decorator",
                reason: "class member decorator",
                dependency: `function shapeField(): PropertyDecorator {
    return () => {};
}

export class UsedShape {
    @shapeField()
    readonly id!: string;
}
`,
            },
            {
                name: "enum initializer",
                reason: "enum initializer",
                dependency: `export enum UsedShape {
    Active = "active",
}
`,
            },
            {
                name: "duplicate top-level declaration",
                reason: "duplicate top-level declaration",
                dependency: `export interface UsedShape {
    readonly id: string;
}

export class UsedShape {}
`,
            },
            {
                name: "missing required symbol",
                reason: "missing required symbol",
                dependency: `export interface OtherShape {
    readonly id: string;
}
`,
            },
        ])(
            "should reject safe-symbols dependency slicing for $name",
            async ({ dependency, reason, extraFiles }) => {
                await expectUnsafeDependencySlice(dependency, reason, {
                    extraFiles,
                });
            }
        );

        it("should report the entry path for unsupported local default imports", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import UsedShape from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly shape!: UsedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "shapes.ts"),
                `export default interface UsedShape {
    readonly id: string;
}
`
            );

            await expectUnsafeDependencySliceError(
                copySingleEntry(sourceFile, testDir, outputDir, {
                    entryStrategy: "symbols",
                    dependencyStrategy: "safe-symbols",
                }),
                {
                    filePath: sourceFile,
                    reason: "unsupported import shape: default import",
                }
            );
        });

        it("should report the entry path for unsupported local namespace imports", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import * as Shapes from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly shape!: Shapes.UsedShape;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "shapes.ts"),
                `export interface UsedShape {
    readonly id: string;
}
`
            );

            await expectUnsafeDependencySliceError(
                copySingleEntry(sourceFile, testDir, outputDir, {
                    entryStrategy: "symbols",
                    dependencyStrategy: "safe-symbols",
                }),
                {
                    filePath: sourceFile,
                    reason: "unsupported import shape: namespace import",
                }
            );
        });

        it("should retain value declarations referenced by type query dependencies", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `import { ContractQuery } from "@hexaijs/contracts";
import { TokenEnvelope } from "./shapes.js";

@ContractQuery()
export class FindUserQuery {
    readonly envelope!: TokenEnvelope;
}
`
            );
            fs.writeFileSync(
                path.join(testDir, "shapes.ts"),
                `export const TOKEN = "profile";
export const TOKEN_KIND = "primary" as const;

export type TokenValue = typeof TOKEN;
export type TokenKind = typeof TOKEN_KIND;

export interface TokenEnvelope {
    readonly token: TokenValue;
    readonly kind: TokenKind;
}

export interface UnusedShape {
    readonly unused: string;
}
`
            );

            await copySingleEntry(sourceFile, testDir, outputDir, {
                entryStrategy: "symbols",
                dependencyStrategy: "safe-symbols",
            });

            const dependencyContent = fs.readFileSync(
                path.join(outputDir, "shapes.ts"),
                "utf-8"
            );

            expect(dependencyContent).toContain('export const TOKEN = "profile"');
            expect(dependencyContent).toContain(
                'export const TOKEN_KIND = "primary" as const'
            );
            expect(dependencyContent).toContain(
                "export type TokenValue = typeof TOKEN"
            );
            expect(dependencyContent).toContain(
                "export type TokenKind = typeof TOKEN_KIND"
            );
            expect(dependencyContent).toContain("export interface TokenEnvelope");
            expect(dependencyContent).not.toContain("UnusedShape");
        });
    });

    describe("excluded import removal", () => {
        const excludePatternsFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/exclude-patterns/src"
        );

        it("should remove import statements for excluded files", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: [
                    "**/*.test.ts",
                    "**/*.spec.ts",
                    "**/*.eh.ts",
                    "**/db.ts",
                    "**/infra/**",
                ],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: excludePatternsFixtureRoot,
                outputDir,
                fileGraph,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "query.ts"),
                "utf-8"
            );

            // Should NOT contain imports to excluded files
            expect(copiedContent).not.toContain("./read-model-manager.eh");
            expect(copiedContent).not.toContain("./db");
            expect(copiedContent).not.toContain("./infra/service");
            expect(copiedContent).not.toContain("./test-helper.test");
            expect(copiedContent).not.toContain("./spec-helper.spec");

            // Should still contain import to non-excluded file
            expect(copiedContent).toContain("./types");
        });

        it("should remove unused import identifiers after removing excluded imports", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/*.eh.ts"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );
            const fileGraph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const copier = new FileCopier();
            await copier.copyFiles({
                sourceRoot: excludePatternsFixtureRoot,
                outputDir,
                fileGraph,
            });

            const copiedContent = fs.readFileSync(
                path.join(outputDir, "query.ts"),
                "utf-8"
            );

            // The import { ReadModelManager } from "./read-model-manager.eh" should be removed
            expect(copiedContent).not.toContain("ReadModelManager");
        });
    });

    describe("responseTypesToExport", () => {
        it("should add export to unexported type alias", async () => {
            // Create a test file with unexported type alias
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `export class CreateUserCommand {}

type CreateUserResult = {
    userId: string;
};
`
            );

            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const fileGraph = await resolver.buildGraph([sourceFile], testDir);

            const copier = new FileCopier();
            const copyOutputDir = path.join(outputDir, "output");

            const responseTypesToExport = new Map<string, string[]>();
            responseTypesToExport.set(sourceFile, ["CreateUserResult"]);

            await copier.copyFiles({
                sourceRoot: testDir,
                outputDir: copyOutputDir,
                fileGraph,
                responseTypesToExport,
            });

            const copiedContent = fs.readFileSync(
                path.join(copyOutputDir, "command.ts"),
                "utf-8"
            );

            expect(copiedContent).toContain("export type CreateUserResult");
        });

        it("should add export to unexported interface", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "query.ts");
            fs.writeFileSync(
                sourceFile,
                `export class GetUserQuery {}

interface GetUserResult {
    name: string;
    email: string;
}
`
            );

            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const fileGraph = await resolver.buildGraph([sourceFile], testDir);

            const copier = new FileCopier();
            const copyOutputDir = path.join(outputDir, "output");

            const responseTypesToExport = new Map<string, string[]>();
            responseTypesToExport.set(sourceFile, ["GetUserResult"]);

            await copier.copyFiles({
                sourceRoot: testDir,
                outputDir: copyOutputDir,
                fileGraph,
                responseTypesToExport,
            });

            const copiedContent = fs.readFileSync(
                path.join(copyOutputDir, "query.ts"),
                "utf-8"
            );

            expect(copiedContent).toContain("export interface GetUserResult");
        });

        it("should not modify already exported types", async () => {
            const testDir = path.join(outputDir, "source");
            fs.mkdirSync(testDir, { recursive: true });

            const sourceFile = path.join(testDir, "command.ts");
            fs.writeFileSync(
                sourceFile,
                `export class CreateUserCommand {}

export type CreateUserResult = {
    userId: string;
};
`
            );

            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const fileGraph = await resolver.buildGraph([sourceFile], testDir);

            const copier = new FileCopier();
            const copyOutputDir = path.join(outputDir, "output");

            const responseTypesToExport = new Map<string, string[]>();
            responseTypesToExport.set(sourceFile, ["CreateUserResult"]);

            const result = await copier.copyFiles({
                sourceRoot: testDir,
                outputDir: copyOutputDir,
                fileGraph,
                responseTypesToExport,
            });

            const copiedContent = fs.readFileSync(
                path.join(copyOutputDir, "command.ts"),
                "utf-8"
            );

            // Should still have export (not doubled)
            expect(copiedContent).toContain("export type CreateUserResult");
            // No "added export" rewrite should be recorded
            const rewrites = result.rewrittenImports.get(
                path.join(copyOutputDir, "command.ts")
            );
            expect(rewrites ?? []).not.toContainEqual(
                expect.stringContaining("added export")
            );
        });
    });
});
