import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { run, runWithConfig } from "@/cli";

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
                        sourceDir: join(fixturesDir, "lecture", "src"),
                    },
                ],
            },
        };
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
                            sourceDir: join(
                                fixturesDir,
                                "multi-context",
                                "src",
                                "orders"
                            ),
                        },
                        {
                            name: "inventory",
                            sourceDir: join(
                                fixturesDir,
                                "multi-context",
                                "src",
                                "inventory"
                            ),
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
                            sourceDir: join(fixturesDir, "path-alias", "src"),
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

        it("should throw error when --output-dir is missing", async () => {
            await createConfig(createLectureConfig());

            await expect(run(["--config", configPath])).rejects.toThrow(
                "Missing required option: --output-dir"
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

        it("should throw error for invalid context (missing sourceDir)", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "test",
                            // missing sourceDir
                        },
                    ],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");

            await expect(
                run(["--config", configPath, "--output-dir", contractsDir])
            ).rejects.toThrow("missing 'sourceDir'");
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
            expect(indexContent).toContain("./lecture");
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
                            sourceDir: join(
                                fixturesDir,
                                "decorator-removal",
                                "src"
                            ),
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
});
