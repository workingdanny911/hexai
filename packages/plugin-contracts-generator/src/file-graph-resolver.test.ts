import { describe, it, expect } from "vitest";
import path from "path";

import { FileGraphResolver } from "./file-graph-resolver";
import { ContextConfig } from "./context-config";
import type { FileGraph, FileNode, ImportInfo } from "./file-graph-resolver";

function createTestContextConfig(sourceDir: string): ContextConfig {
    return ContextConfig.createSync("test-context", sourceDir);
}

describe("FileGraphResolver", () => {
    const fixtureRoot = path.resolve(
        __dirname,
        "../e2e/fixtures/module-structure/src"
    );

    describe("single file with no local dependencies", () => {
        it("should create a graph with one node for an entry point that has no local imports", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(fixtureRoot, "is-empty.ts");

            const graph = await resolver.buildGraph([entryPoint], fixtureRoot);

            expect(graph.nodes.size).toBe(1);
            expect(graph.entryPoints.has(entryPoint)).toBe(true);

            const node = graph.nodes.get(entryPoint);
            expect(node).toBeDefined();
            expect(node!.absolutePath).toBe(entryPoint);
            expect(node!.relativePath).toBe("is-empty.ts");
            expect(node!.isEntryPoint).toBe(true);
            expect(node!.imports).toHaveLength(0);
        });
    });

    describe("direct local dependency", () => {
        it("should include directly imported local file in the graph", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(fixtureRoot, "foo.validator.ts");

            const graph = await resolver.buildGraph([entryPoint], fixtureRoot);

            expect(graph.nodes.size).toBe(2);

            const entryNode = graph.nodes.get(entryPoint);
            expect(entryNode).toBeDefined();
            expect(entryNode!.isEntryPoint).toBe(true);

            expect(entryNode!.imports).toHaveLength(1);
            const importInfo = entryNode!.imports[0];
            expect(importInfo.moduleSpecifier).toBe("./is-empty");
            expect(importInfo.isExternal).toBe(false);
            expect(importInfo.resolvedPath).toBe(
                path.join(fixtureRoot, "is-empty.ts")
            );
            expect(importInfo.importedNames).toContain("isEmpty");

            const isEmptyPath = path.join(fixtureRoot, "is-empty.ts");
            const isEmptyNode = graph.nodes.get(isEmptyPath);
            expect(isEmptyNode).toBeDefined();
            expect(isEmptyNode!.isEntryPoint).toBe(false);
        });
    });

    describe("transitive dependencies", () => {
        it("should follow imports transitively using BFS", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );

            const graph = await resolver.buildGraph([entryPoint], fixtureRoot);

            expect(graph.nodes.size).toBe(4);

            const expectedFiles = [
                "commands-but-different-filename.ts",
                "foo.validator.ts",
                "bar.validator.ts",
                "is-empty.ts",
            ];

            for (const fileName of expectedFiles) {
                const filePath = path.join(fixtureRoot, fileName);
                expect(graph.nodes.has(filePath)).toBe(true);
            }

            expect(graph.entryPoints.size).toBe(1);
            expect(graph.entryPoints.has(entryPoint)).toBe(true);
        });
    });

    describe("external package imports", () => {
        it("should mark external package imports with isExternal true and resolvedPath null", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );

            const graph = await resolver.buildGraph([entryPoint], fixtureRoot);

            const entryNode = graph.nodes.get(entryPoint);
            expect(entryNode).toBeDefined();

            const hexaiImport = entryNode!.imports.find(
                (i) => i.moduleSpecifier === "@hexaijs/core"
            );
            expect(hexaiImport).toBeDefined();
            expect(hexaiImport!.isExternal).toBe(true);
            expect(hexaiImport!.resolvedPath).toBeNull();
            expect(hexaiImport!.importedNames).toContain("Message");
        });
    });

    describe("path alias imports", () => {
        it("should treat unresolved path aliases as external imports", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                fixtureRoot,
                "commands-but-different-filename.ts"
            );

            const graph = await resolver.buildGraph([entryPoint], fixtureRoot);

            const entryNode = graph.nodes.get(entryPoint);
            expect(entryNode).toBeDefined();

            const aliasImport = entryNode!.imports.find(
                (i) => i.moduleSpecifier === "@/decorators"
            );
            expect(aliasImport).toBeDefined();
            expect(aliasImport!.isExternal).toBe(true);
            expect(aliasImport!.resolvedPath).toBeNull();
            expect(aliasImport!.importedNames).toContain("PublicCommand");
        });
    });

    describe("export * from re-exports", () => {
        const barrelExportFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/barrel-export/src"
        );

        it("should follow 'export * from' and 'export { X } from' declarations as dependencies", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(barrelExportFixtureRoot, "entry.ts");

            const graph = await resolver.buildGraph(
                [entryPoint],
                barrelExportFixtureRoot
            );

            // entry.ts has "export * from './sub-module'"
            // sub-module/index.ts has:
            //   - "export * from './types'"
            //   - "export { helperFunction } from './helpers'"
            // So the graph should include: entry.ts, sub-module/index.ts, sub-module/types.ts, sub-module/helpers.ts
            expect(graph.nodes.size).toBe(4);

            const expectedFiles = [
                "entry.ts",
                "sub-module/index.ts",
                "sub-module/types.ts",
                "sub-module/helpers.ts",
            ];

            for (const fileName of expectedFiles) {
                const filePath = path.join(barrelExportFixtureRoot, fileName);
                expect(graph.nodes.has(filePath)).toBe(true);
            }
        });

        it("should include export declaration info in the imports array", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(barrelExportFixtureRoot, "entry.ts");

            const graph = await resolver.buildGraph(
                [entryPoint],
                barrelExportFixtureRoot
            );

            const entryNode = graph.nodes.get(entryPoint);
            expect(entryNode).toBeDefined();

            // The "export * from './sub-module'" should be in imports
            const subModuleExport = entryNode!.imports.find(
                (i) => i.moduleSpecifier === "./sub-module"
            );
            expect(subModuleExport).toBeDefined();
            expect(subModuleExport!.isExternal).toBe(false);
            expect(subModuleExport!.resolvedPath).toBe(
                path.join(barrelExportFixtureRoot, "sub-module/index.ts")
            );
        });
    });

    describe("path alias resolution with tsconfig", () => {
        const pathAliasFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/path-alias"
        );
        const pathAliasSrcRoot = path.join(pathAliasFixtureRoot, "src");

        async function createPathAliasContextConfig(): Promise<ContextConfig> {
            return ContextConfig.create(
                {
                    name: "path-alias-test",
                    path: ".",
                    sourceDir: "src",
                    tsconfigPath: "tsconfig.json",
                },
                pathAliasFixtureRoot
            );
        }

        it("should resolve path alias when tsconfig is provided", async () => {
            const contextConfig = await createPathAliasContextConfig();
            const resolver = FileGraphResolver.create({ contextConfig });
            const entryPoint = path.join(pathAliasSrcRoot, "events.ts");

            const graph = await resolver.buildGraph(
                [entryPoint],
                pathAliasSrcRoot
            );

            const entryNode = graph.nodes.get(entryPoint);
            expect(entryNode).toBeDefined();

            const decoratorsImport = entryNode!.imports.find(
                (i) => i.moduleSpecifier === "@/decorators"
            );
            expect(decoratorsImport).toBeDefined();
            expect(decoratorsImport!.isExternal).toBe(false);
            expect(decoratorsImport!.resolvedPath).toBe(
                path.join(pathAliasSrcRoot, "decorators/index.ts")
            );
        });

        it("should include resolved path alias dependencies in the graph", async () => {
            const contextConfig = await createPathAliasContextConfig();
            const resolver = FileGraphResolver.create({ contextConfig });
            const entryPoint = path.join(pathAliasSrcRoot, "events.ts");

            const graph = await resolver.buildGraph(
                [entryPoint],
                pathAliasSrcRoot
            );

            expect(graph.nodes.size).toBe(3);

            const decoratorsPath = path.join(
                pathAliasSrcRoot,
                "decorators/index.ts"
            );
            expect(graph.nodes.has(decoratorsPath)).toBe(true);

            const decoratorsNode = graph.nodes.get(decoratorsPath);
            expect(decoratorsNode!.isEntryPoint).toBe(false);
        });

        it("should still treat external packages as external even with tsconfig", async () => {
            const contextConfig = await createPathAliasContextConfig();
            const resolver = FileGraphResolver.create({ contextConfig });
            const entryPoint = path.join(pathAliasSrcRoot, "events.ts");

            const graph = await resolver.buildGraph(
                [entryPoint],
                pathAliasSrcRoot
            );

            const entryNode = graph.nodes.get(entryPoint);
            const hexaiImport = entryNode!.imports.find(
                (i) => i.moduleSpecifier === "@hexaijs/core"
            );
            expect(hexaiImport).toBeDefined();
            expect(hexaiImport!.isExternal).toBe(true);
            expect(hexaiImport!.resolvedPath).toBeNull();
        });
    });

    describe("dependency exclude patterns", () => {
        const excludePatternsFixtureRoot = path.resolve(
            __dirname,
            "../e2e/fixtures/exclude-patterns/src"
        );

        it("should exclude dependencies matching *.test.ts pattern", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/*.test.ts"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const testFilePath = path.join(
                excludePatternsFixtureRoot,
                "test-helper.test.ts"
            );
            expect(graph.nodes.has(testFilePath)).toBe(false);
        });

        it("should exclude dependencies matching *.spec.ts pattern", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/*.spec.ts"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const specFilePath = path.join(
                excludePatternsFixtureRoot,
                "spec-helper.spec.ts"
            );
            expect(graph.nodes.has(specFilePath)).toBe(false);
        });

        it("should exclude dependencies matching *.eh.ts pattern (event handlers)", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/*.eh.ts"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const ehFilePath = path.join(
                excludePatternsFixtureRoot,
                "read-model-manager.eh.ts"
            );
            expect(graph.nodes.has(ehFilePath)).toBe(false);
        });

        it("should exclude dependencies matching **/db.ts pattern", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/db.ts"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const dbFilePath = path.join(excludePatternsFixtureRoot, "db.ts");
            expect(graph.nodes.has(dbFilePath)).toBe(false);
        });

        it("should exclude dependencies matching **/infra/** pattern", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(excludePatternsFixtureRoot),
                excludeDependencies: ["**/infra/**"],
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            const infraFilePath = path.join(
                excludePatternsFixtureRoot,
                "infra/service.ts"
            );
            expect(graph.nodes.has(infraFilePath)).toBe(false);
        });

        it("should include non-matching dependencies normally", async () => {
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

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            // types.ts should still be included
            const typesFilePath = path.join(
                excludePatternsFixtureRoot,
                "types.ts"
            );
            expect(graph.nodes.has(typesFilePath)).toBe(true);

            // Entry point should always be included
            expect(graph.nodes.has(entryPoint)).toBe(true);
        });

        it("should exclude all matching patterns when multiple patterns provided", async () => {
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

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            // Only entry point and types.ts should be in the graph
            expect(graph.nodes.size).toBe(2);
            expect(graph.nodes.has(entryPoint)).toBe(true);
            expect(
                graph.nodes.has(
                    path.join(excludePatternsFixtureRoot, "types.ts")
                )
            ).toBe(true);
        });

        it("should populate excludedPaths with all excluded dependency paths", async () => {
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

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            // excludedPaths should contain all excluded files
            expect(graph.excludedPaths).toBeDefined();
            expect(graph.excludedPaths.size).toBe(5);
            expect(
                graph.excludedPaths.has(
                    path.join(excludePatternsFixtureRoot, "test-helper.test.ts")
                )
            ).toBe(true);
            expect(
                graph.excludedPaths.has(
                    path.join(excludePatternsFixtureRoot, "spec-helper.spec.ts")
                )
            ).toBe(true);
            expect(
                graph.excludedPaths.has(
                    path.join(
                        excludePatternsFixtureRoot,
                        "read-model-manager.eh.ts"
                    )
                )
            ).toBe(true);
            expect(
                graph.excludedPaths.has(
                    path.join(excludePatternsFixtureRoot, "db.ts")
                )
            ).toBe(true);
            expect(
                graph.excludedPaths.has(
                    path.join(excludePatternsFixtureRoot, "infra/service.ts")
                )
            ).toBe(true);
        });

        it("should have empty excludedPaths when no dependencies are excluded", async () => {
            const resolver = FileGraphResolver.create({
                contextConfig: createTestContextConfig(fixtureRoot),
            });
            const entryPoint = path.join(
                excludePatternsFixtureRoot,
                "query.ts"
            );

            const graph = await resolver.buildGraph(
                [entryPoint],
                excludePatternsFixtureRoot
            );

            expect(graph.excludedPaths).toBeDefined();
            expect(graph.excludedPaths.size).toBe(0);
        });
    });
});
