import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { run, runWithConfig } from "../../src/cli.js";
import { cliPlugin } from "../../src/hexai-plugin.js";
import { expectTypeScriptCompilesWithNodeNext } from "../helpers/typescript-validator.js";

/**
 * CLI E2E Tests
 *
 * These tests focus on CLI-specific functionality:
 * - Config file loading and parsing
 * - CLI options (--config, -c, --config=path, --output-dir)
 * - Error handling for invalid configs
 *
 * For detailed generation logic tests (file content, extraction, etc.),
 * see the tests in the generation/ directory.
 */
describe("CLI E2E", () => {
    const fixturesDir = join(__dirname, "..", "fixtures");
    let outputDir: string;
    let configPath: string;

    beforeEach(async () => {
        const runId = randomBytes(4).toString("hex");
        outputDir = join(__dirname, "..", "output", `cli-run-${runId}`);
        await mkdir(outputDir, { recursive: true });
    });

    afterEach(async () => {
        if (existsSync(outputDir)) {
            await rm(outputDir, { recursive: true });
        }
    });

    async function createConfig(config: object): Promise<string> {
        configPath = join(outputDir, "application.config.ts");
        const content = `export default ${JSON.stringify(config, null, 2)};`;
        await writeFile(configPath, content);
        return configPath;
    }

    function createLectureConfig() {
        return {
            contracts: {
                contexts: [
                    {
                        name: "lecture",
                        path: join(fixturesDir, "lecture"),
                    },
                ],
            },
        };
    }

    function createMessagesAndPublicContractsConfig() {
        return {
            contracts: {
                contexts: [
                    {
                        name: "lecture",
                        path: join(fixturesDir, "lecture"),
                    },
                    {
                        name: "public-contract",
                        path: join(fixturesDir, "public-contract"),
                    },
                ],
            },
        };
    }

    function createSymbolExtractionConfig() {
        return {
            contracts: {
                contexts: [
                    {
                        name: "symbol-extraction",
                        path: join(fixturesDir, "symbol-extraction"),
                    },
                ],
            },
        };
    }

    async function createOutputSelectionConfig() {
        const projectDir = join(outputDir, "output-selection-project");
        const sourceDir = join(projectDir, "src");
        await mkdir(sourceDir, { recursive: true });
        await writeFile(
            join(sourceDir, "messages.ts"),
            `
import { ContractCommand, ContractEvent, ContractQuery } from "@hexaijs/contracts/decorators";

@ContractQuery()
export class GetPublicCatalogQuery {}

@ContractEvent()
export class PublicCatalogChanged {}

@ContractCommand({ visibility: "internal", tags: ["bus"] })
export class RebuildInternalIndexCommand {}
`
        );

        return {
            contracts: {
                contexts: [
                    {
                        name: "catalog",
                        path: projectDir,
                    },
                ],
                outputs: [
                    {
                        name: "public",
                        path: "public-contracts",
                        select: { visibility: ["public"] },
                    },
                    {
                        name: "internal",
                        path: "internal-contracts",
                        registry: true,
                        select: {
                            visibility: ["internal"],
                            messageKinds: ["command"],
                            tags: { include: ["bus"] },
                        },
                    },
                ],
            },
        };
    }

    async function expectNoGeneratedFiles(path: string): Promise<void> {
        if (!existsSync(path)) {
            return;
        }

        await expect(readdir(path)).resolves.toEqual([]);
    }

    describe("config file loading", () => {
        it("should process contexts from config file", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should process multiple contexts from config", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "orders",
                            path: join(fixturesDir, "multi-context"),
                            sourceDir: "src/orders",
                        },
                        {
                            name: "inventory",
                            path: join(fixturesDir, "multi-context"),
                            sourceDir: "src/inventory",
                        },
                    ],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "orders"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory"))).toBe(true);
        });

        it("should apply pathAliasRewrites from config", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "path-alias",
                            path: join(fixturesDir, "path-alias"),
                        },
                    ],
                    pathAliasRewrites: {
                        "@/decorators": "@libera/decorators",
                    },
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            // Just verify the output was created - detailed content tests are in path-alias-rewrite.test.ts
            expect(existsSync(join(contractsDir, "path-alias"))).toBe(true);
        });
    });

    describe("CLI options", () => {
        it("should accept -c as short form of --config", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["-c", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should accept --config=path format", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([`--config=${configPath}`, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should accept -o as short form of --output-dir", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "-o", contractsDir]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should accept --output-dir=path format", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, `--output-dir=${contractsDir}`]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should accept --output-module-specifiers=extensionless", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--registry",
                "--output-module-specifiers=extensionless",
            ]);

            const rootRegistryContent = readFileSync(
                join(contractsDir, "index.ts"),
                "utf-8"
            );
            const contextIndexContent = readFileSync(
                join(contractsDir, "lecture", "index.ts"),
                "utf-8"
            );

            expect(rootRegistryContent).toContain('from "./lecture"');
            expect(rootRegistryContent).not.toContain("./lecture/index.js");
            expect(contextIndexContent).toContain("export * from './events'");
            expect(contextIndexContent).not.toContain("export * from './events.js'");
        });

        it("should reject invalid --output-module-specifiers", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run([
                    "--config",
                    configPath,
                    "-o",
                    contractsDir,
                    "--output-module-specifiers",
                    "cjs",
                ])
            ).rejects.toThrow('Invalid --output-module-specifiers: "cjs"');
        });

        it("should throw error when --output-dir is missing", async () => {
            await createConfig(createLectureConfig());

            await expect(run(["--config", configPath])).rejects.toThrow(
                "Missing required option: --output-dir"
            );
        });

        it("should use contracts.outputs without --output-dir", async () => {
            await createConfig(await createOutputSelectionConfig());

            await run(["--config", configPath]);

            const publicFile = join(
                outputDir,
                "public-contracts",
                "catalog",
                "messages.ts"
            );
            const internalFile = join(
                outputDir,
                "internal-contracts",
                "catalog",
                "messages.ts"
            );

            expect(existsSync(publicFile)).toBe(true);
            expect(existsSync(internalFile)).toBe(true);

            const publicContent = readFileSync(publicFile, "utf-8");
            const internalContent = readFileSync(internalFile, "utf-8");

            expect(publicContent).toContain("GetPublicCatalogQuery");
            expect(publicContent).toContain("PublicCatalogChanged");
            expect(publicContent).not.toContain("RebuildInternalIndexCommand");
            expect(internalContent).toContain("RebuildInternalIndexCommand");
            expect(internalContent).not.toContain("GetPublicCatalogQuery");
            expect(internalContent).not.toContain("PublicCatalogChanged");
            expect(existsSync(join(outputDir, "internal-contracts", "index.ts"))).toBe(
                true
            );
        });

        it("should reject --output-dir when contracts.outputs is configured", async () => {
            await createConfig(await createOutputSelectionConfig());

            await expect(
                run(["--config", configPath, "--output-dir", join(outputDir, "contracts")])
            ).rejects.toThrow(
                "Cannot use --output-dir when contracts.outputs is configured"
            );
        });
    });

    describe("error handling", () => {
        it("should throw error for missing contracts section", async () => {
            const config = {
                handlers: ["./handlers/*.ts"],
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run(["--config", configPath, "--output-dir", contractsDir])
            ).rejects.toThrow("Missing 'contracts' section");
        });

        it("should throw error for invalid context (missing path)", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "test",
                            // missing path
                        },
                    ],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run(["--config", configPath, "--output-dir", contractsDir])
            ).rejects.toThrow("missing 'path'");
        });

        it("should throw error for non-existent config file", async () => {
            const contractsDir = join(outputDir, "contracts");
            await expect(
                run([
                    "--config",
                    "/non/existent/config.ts",
                    "--output-dir",
                    contractsDir,
                ])
            ).rejects.toThrow();
        });
    });

    describe("removeDecorators option", () => {
        it("should remove @PublicCommand decorator when removeDecorators is true", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    removeDecorators: true,
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).not.toContain("@PublicCommand()");
            expect(content).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            expect(content).toContain("export class PlaceOrderCommand");
        });

        it("should remove @PublicEvent decorator when removeDecorators is true", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    removeDecorators: true,
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "event-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).not.toContain("@PublicEvent()");
            expect(content).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            expect(content).toContain("export class OrderPlaced");
        });

        it("should remove decorators by default when removeDecorators is not set", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    // removeDecorators not set (defaults to true)
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).not.toContain("@PublicCommand()");
            expect(content).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
        });

        it("should keep decorators when removeDecorators is explicitly false", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    removeDecorators: false,
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).toContain("@PublicCommand()");
            expect(content).toContain("@hexaijs/plugin-contracts-generator");
        });
    });

    describe("--message-types option", () => {
        it("should accept -m as short form of --message-types", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "-m",
                "event",
            ]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should accept --message-types=value format", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--message-types=event",
            ]);

            expect(existsSync(join(contractsDir, "lecture"))).toBe(true);
        });

        it("should extract only events when --message-types=event", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "-m",
                "event",
            ]);

            // events.ts should exist (contains @PublicEvent)
            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );

            // commands.ts should NOT exist (filtered out)
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(false);
        });

        it("should extract only commands when --message-types=command", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "-m",
                "command",
            ]);

            // commands.ts should exist (contains @PublicCommand)
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(true);

            // events.ts should NOT exist (filtered out)
            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                false
            );
        });

        it("should extract both events and commands when --message-types=event,command", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "-m",
                "event,command",
            ]);

            // Both should exist
            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(true);
        });

        it("should throw error for missing value", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run(["--config", configPath, "-o", contractsDir, "-m"])
            ).rejects.toThrow("Missing value for --message-types option");
        });

        it("should throw error for invalid message type", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run([
                    "--config",
                    configPath,
                    "-o",
                    contractsDir,
                    "-m",
                    "invalid",
                ])
            ).rejects.toThrow("Invalid message type(s): invalid");
        });

        it("should throw error for partially invalid message types", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run([
                    "--config",
                    configPath,
                    "-o",
                    contractsDir,
                    "-m",
                    "event,invalid",
                ])
            ).rejects.toThrow("Invalid message type(s): invalid");
        });
    });

    describe("--include option", () => {
        it("should generate messages and PublicContract-only files when --include all", async () => {
            await createConfig(createMessagesAndPublicContractsConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--include",
                "all",
            ]);

            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(true);
            expect(
                existsSync(
                    join(contractsDir, "public-contract", "contracts.ts")
                )
            ).toBe(true);
        });

        it("should exclude PublicContract-only files when --include messages", async () => {
            await createConfig(createMessagesAndPublicContractsConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--include",
                "messages",
            ]);

            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(true);
            expect(
                existsSync(
                    join(contractsDir, "public-contract", "contracts.ts")
                )
            ).toBe(false);
        });

        it("should generate PublicContract-only files without messages when --include contracts", async () => {
            await createConfig(createMessagesAndPublicContractsConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--include",
                "contracts",
            ]);

            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                false
            );
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(false);
            expect(
                existsSync(
                    join(contractsDir, "public-contract", "contracts.ts")
                )
            ).toBe(true);
        });
    });

    describe("--messages option", () => {
        it("should extract only events when --messages=event", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--messages=event",
            ]);

            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(false);
        });

        it("should extract symbols by default when --messages=event", async () => {
            await createConfig(createSymbolExtractionConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--messages=event",
            ]);

            const content = readFileSync(
                join(contractsDir, "symbol-extraction", "mixed-messages.ts"),
                "utf-8"
            );
            expect(content).toContain("export class UserRegistered");
            expect(content).not.toContain("export class RegisterUser");
            expect(content).not.toContain("export class RegisterUserHandler");
            expect(content).not.toContain("export interface SomeUnrelatedType");
        });

        it("should keep graph-copy semantics when --entry-strategy=graph and --messages=event", async () => {
            await createConfig(createSymbolExtractionConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--messages=event",
                "--entry-strategy=graph",
            ]);

            const content = readFileSync(
                join(contractsDir, "symbol-extraction", "mixed-messages.ts"),
                "utf-8"
            );
            expect(content).toContain("export class UserRegistered");
            expect(content).toContain("export class RegisterUser");
            expect(content).toContain("export class RegisterUserHandler");
            expect(content).toContain("export interface SomeUnrelatedType");
        });

        it("should extract only commands when --messages command", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--messages",
                "command",
            ]);

            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(true);
            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                false
            );
        });
    });

    describe("--entry-strategy option", () => {
        it("should accept --entry-strategy=symbols and extract marked PublicContract symbols only", async () => {
            await createConfig(createMessagesAndPublicContractsConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--entry-strategy=symbols",
            ]);

            const content = readFileSync(
                join(contractsDir, "public-contract", "contracts.ts"),
                "utf-8"
            );
            expect(content).toContain("export interface PublicProfile");
            expect(content).toContain("export type PublicUserId");
            expect(content).toContain("export class PublicProjection");
            expect(content).toContain("export enum PublicStatus");
            expect(content).toContain("deriveDisplayName");
            expect(content).toContain("DEFAULT_STATUS");
            expect(content).toContain("Status.Active");
            expect(content).toContain("Factory.create()");
            expect(content).not.toContain("InternalProfileRecord");
            expect(content).not.toContain("InternalProjection");
        });
    });

    describe("--generate-message-registry option", () => {
        it("should not generate index.ts by default", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "-o", contractsDir]);

            // index.ts should NOT exist by default
            expect(existsSync(join(contractsDir, "index.ts"))).toBe(false);
        });

        it("should generate index.ts when --generate-message-registry is provided", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--generate-message-registry",
            ]);

            // index.ts should exist with the flag
            expect(existsSync(join(contractsDir, "index.ts"))).toBe(true);
        });

        it("should generate correct registry content", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--generate-message-registry",
            ]);

            const indexContent = readFileSync(
                join(contractsDir, "index.ts"),
                "utf-8"
            );

            // Should contain namespace exports
            expect(indexContent).toContain("lecture");
            // Should import from the context
            expect(indexContent).toContain("./lecture/index.js");
        });

        it("should generate a root registry that compiles with NodeNext", async () => {
            await createConfig({
                contracts: {
                    contexts: [
                        {
                            name: "catalog",
                            path: join(fixturesDir, "contract-api"),
                        },
                    ],
                },
            });
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--generate-message-registry",
            ]);

            await expectTypeScriptCompilesWithNodeNext(contractsDir);
        });

        it("should work with --message-types and --generate-message-registry together", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "-m",
                "event",
                "--generate-message-registry",
            ]);

            // Both events.ts and index.ts should exist
            expect(existsSync(join(contractsDir, "lecture", "events.ts"))).toBe(
                true
            );
            expect(existsSync(join(contractsDir, "index.ts"))).toBe(true);

            // commands.ts should not exist (filtered out)
            expect(
                existsSync(join(contractsDir, "lecture", "commands.ts"))
            ).toBe(false);

            const registryContent = readFileSync(
                join(contractsDir, "index.ts"),
                "utf-8"
            );
            expect(registryContent).toContain("LectureCreated");
            expect(registryContent).toContain("LectureDeleted");
            expect(registryContent).not.toContain("CreateLecture");
        });
    });

    describe("--registry option", () => {
        it("should generate index.ts when --registry alias is provided", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--registry",
            ]);

            expect(existsSync(join(contractsDir, "index.ts"))).toBe(true);
        });
    });

    describe("--dry-run option", () => {
        it("should not create files in outputDir", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "dry-run-contracts");
            await run([
                "--config",
                configPath,
                "-o",
                contractsDir,
                "--dry-run",
            ]);

            await expectNoGeneratedFiles(contractsDir);
        });
    });

    describe("--check option", () => {
        it("should pass when outputDir is up to date", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "-o", contractsDir]);

            await expect(
                run(["--config", configPath, "-o", contractsDir, "--check"])
            ).resolves.toBeUndefined();
        });

        it("should fail when outputDir is empty", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await mkdir(contractsDir, { recursive: true });

            await expect(
                run(["--config", configPath, "-o", contractsDir, "--check"])
            ).rejects.toThrow();
        });

        it("should fail when outputDir is stale", async () => {
            await createConfig(createLectureConfig());
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "-o", contractsDir]);
            await writeFile(
                join(contractsDir, "lecture", "events.ts"),
                "export const stale = true;\n"
            );

            await expect(
                run(["--config", configPath, "-o", contractsDir, "--check"])
            ).rejects.toThrow();
        });
    });
});

/**
 * runWithConfig E2E Tests
 *
 * These tests verify the behavior of runWithConfig, which is used
 * by the hexai CLI plugin integration.
 */
describe("runWithConfig E2E", () => {
    const fixturesDir = join(__dirname, "..", "fixtures");
    let outputDir: string;

    beforeEach(async () => {
        const runId = randomBytes(4).toString("hex");
        outputDir = join(__dirname, "..", "output", `run-with-config-${runId}`);
        await mkdir(outputDir, { recursive: true });
    });

    afterEach(async () => {
        if (existsSync(outputDir)) {
            await rm(outputDir, { recursive: true });
        }
    });

    describe("removeDecorators default value", () => {
        it("should remove decorators by default when removeDecorators is not set in plugin config", async () => {
            const contractsDir = join(outputDir, "contracts");

            await runWithConfig(
                { outputDir: contractsDir },
                {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    // removeDecorators intentionally not set
                }
            );

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).not.toContain("@PublicCommand()");
            expect(content).not.toContain(
                "@hexaijs/plugin-contracts-generator"
            );
            expect(content).toContain("export class PlaceOrderCommand");
        });

        it("should remove decorators when removeDecorators is explicitly true", async () => {
            const contractsDir = join(outputDir, "contracts");

            await runWithConfig(
                { outputDir: contractsDir },
                {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    removeDecorators: true,
                }
            );

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).not.toContain("@PublicCommand()");
        });

        it("should keep decorators when removeDecorators is explicitly false", async () => {
            const contractsDir = join(outputDir, "contracts");

            await runWithConfig(
                { outputDir: contractsDir },
                {
                    contexts: [
                        {
                            name: "decorator-removal",
                            path: join(fixturesDir, "decorator-removal"),
                        },
                    ],
                    removeDecorators: false,
                }
            );

            const outputFile = join(
                contractsDir,
                "decorator-removal",
                "command-with-decorator.ts"
            );
            expect(existsSync(outputFile)).toBe(true);

            const content = readFileSync(outputFile, "utf-8");
            expect(content).toContain("@PublicCommand()");
            expect(content).toContain("@hexaijs/plugin-contracts-generator");
        });
    });

    describe("Hexai plugin CLI options", () => {
        it("should pass outputModuleSpecifiers from plugin args", async () => {
            const contractsDir = join(outputDir, "plugin-contracts");

            await cliPlugin.run(
                {
                    outputDir: contractsDir,
                    registry: true,
                    outputModuleSpecifiers: "extensionless",
                },
                {
                    contexts: [
                        {
                            name: "lecture",
                            path: join(fixturesDir, "lecture"),
                        },
                    ],
                }
            );

            const rootRegistryContent = readFileSync(
                join(contractsDir, "index.ts"),
                "utf-8"
            );
            expect(rootRegistryContent).toContain('from "./lecture"');
            expect(rootRegistryContent).not.toContain("./lecture/index.js");
        });

        it("should reject invalid plugin outputModuleSpecifiers args", async () => {
            await expect(
                cliPlugin.run(
                    {
                        outputDir: join(outputDir, "plugin-contracts"),
                        outputModuleSpecifiers: "cjs",
                    },
                    {
                        contexts: [
                            {
                                name: "lecture",
                                path: join(fixturesDir, "lecture"),
                            },
                        ],
                    }
                )
            ).rejects.toThrow('Invalid outputModuleSpecifiers: "cjs"');
        });
    });

    describe("Hexai plugin outputs config", () => {
        async function expectInvalidPluginConfig(
            override: Record<string, unknown>,
            expectedMessage: string
        ): Promise<void> {
            const projectDir = join(outputDir, "invalid-plugin-config-project");
            await mkdir(join(projectDir, "src"), { recursive: true });

            await expect(
                cliPlugin.run(
                    {},
                    {
                        contexts: [{ name: "app", path: projectDir }],
                        outputs: [
                            {
                                name: "public",
                                path: join(outputDir, "plugin-public-contracts"),
                            },
                        ],
                        ...override,
                    } as unknown as Parameters<typeof cliPlugin.run>[1]
                )
            ).rejects.toThrow(expectedMessage);
        }

        it("should run with contracts.outputs and no outputDir argument", async () => {
            const projectDir = join(outputDir, "plugin-output-project");
            const sourceDir = join(projectDir, "src");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "messages.ts"),
                `
import { ContractCommand } from "@hexaijs/contracts";

@ContractCommand()
export class CreateUserCommand {}
`
            );

            await cliPlugin.run(
                {},
                {
                    contexts: [{ name: "app", path: projectDir }],
                    outputs: [
                        {
                            name: "public",
                            path: join(outputDir, "plugin-public-contracts"),
                            select: { visibility: ["public"] },
                        },
                    ],
                }
            );

            expect(
                existsSync(
                    join(
                        outputDir,
                        "plugin-public-contracts",
                        "app",
                        "messages.ts"
                    )
                )
            ).toBe(true);
        });

        it("should reject empty plugin outputs", async () => {
            await expectInvalidPluginConfig(
                { outputs: [] },
                "Invalid contracts.outputs: expected at least one output"
            );
        });

        it("should reject plugin output missing name", async () => {
            await expectInvalidPluginConfig(
                { outputs: [{ path: join(outputDir, "contracts") }] },
                "Invalid contracts.outputs[0]: missing 'name'"
            );
        });

        it("should reject plugin output missing path", async () => {
            await expectInvalidPluginConfig(
                { outputs: [{ name: "public" }] },
                "Invalid contracts.outputs[0]: missing 'path'"
            );
        });

        it("should reject duplicate plugin output names", async () => {
            await expectInvalidPluginConfig(
                {
                    outputs: [
                        { name: "public", path: join(outputDir, "contracts") },
                        {
                            name: "public",
                            path: join(outputDir, "contracts-copy"),
                        },
                    ],
                },
                'Invalid contracts.outputs[1]: duplicate name "public"'
            );
        });

        it("should reject invalid plugin trusted decorator sources", async () => {
            await expectInvalidPluginConfig(
                { trustedDecoratorSources: ["@app/contracts", 42] },
                "Invalid contracts.trustedDecoratorSources: expected string array"
            );
        });

        it("should reject invalid plugin output visibility", async () => {
            await expectInvalidPluginConfig(
                {
                    outputs: [
                        {
                            name: "public",
                            path: join(outputDir, "contracts"),
                            select: { visibility: ["private"] },
                        },
                    ],
                },
                'Invalid contracts.outputs[0].select.visibility: "private"'
            );
        });

        it("should reject invalid plugin output registry type", async () => {
            await expectInvalidPluginConfig(
                {
                    outputs: [
                        {
                            name: "public",
                            path: join(outputDir, "contracts"),
                            registry: "yes",
                        },
                    ],
                },
                "Invalid contracts.outputs[0].registry: expected boolean"
            );
        });
    });
});
