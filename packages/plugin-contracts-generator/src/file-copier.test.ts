import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { FileCopier } from "./file-copier";
import { FileGraphResolver } from "./file-graph-resolver";

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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
                "export * from './commands-but-different-filename'"
            );
            expect(indexContent).toContain("export * from './foo.validator'");
            expect(indexContent).toContain("export * from './bar.validator'");
            expect(indexContent).toContain("export * from './is-empty'");
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
                "export * from './commands-but-different-filename'"
            );
            expect(indexContent).toContain("export * from './nested/is-empty'");
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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
            const resolver = await FileGraphResolver.create();
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
    });

    describe("excluded import removal", () => {
        const excludePatternsFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/exclude-patterns/src"
        );

        it("should remove import statements for excluded files", async () => {
            const resolver = await FileGraphResolver.create({
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
            const resolver = await FileGraphResolver.create({
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

            const resolver = await FileGraphResolver.create();
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

            const resolver = await FileGraphResolver.create();
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

            const resolver = await FileGraphResolver.create();
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
