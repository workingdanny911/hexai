import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigLoader, ConfigLoadError } from "./config-loader.js";
import type { ContractMarkerNames, DecoratorNames } from "./domain/index.js";

const FIXTURE_CONFIG_ROOT = resolve(__dirname, "../test/fixtures/config");

function fixtureConfigPath(name: string): string {
    return join(FIXTURE_CONFIG_ROOT, name, "application.config.ts");
}

describe("ConfigLoader", () => {
    describe("object context format", () => {
        it("should load contracts config from a valid config file", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("valid-config");

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(1);
            expect(result.contexts[0].name).toBe("lecture");
            expect(result.contexts[0].sourceDir).toContain("valid-config/src");
            expect(result.pathAliasRewrites).toEqual({
                "@/": "@libera/",
            });
        });

        it("should throw ConfigLoadError when context has missing required fields", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("invalid-contexts");

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "missing 'path'"
            );
        });

        it("should load multiple contexts", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("multi-context");

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(2);
            expect(result.contexts[0].name).toBe("lecture");
            expect(result.contexts[1].name).toBe("video-lesson");
        });

        it("should load multiple pathAliasRewrites", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("multi-context");

            const result = await configLoader.load(configPath);

            expect(result.pathAliasRewrites).toEqual({
                "@/decorators": "@libera/decorators",
                "@/types": "@libera/types",
            });
        });
    });

    describe("string context format", () => {
        it("should load context from package's application.config.ts", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("string-context");

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(1);
            expect(result.contexts[0].name).toBe("lecture");
            expect(result.contexts[0].sourceDir).toContain("packages/lecture/src");
        });

        it("should include pathAliasRewrites from root config", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("string-context");

            const result = await configLoader.load(configPath);

            expect(result.pathAliasRewrites).toEqual({
                "@/": "@libera/",
            });
        });

        it("should expand glob pattern in contexts array", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("string-context-glob");

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(2);
            expect(result.contexts.map((c) => c.name).sort()).toEqual([
                "lecture",
                "video-lesson",
            ]);
        });

        it("should resolve sourceDir relative to package directory", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("string-context");

            const result = await configLoader.load(configPath);

            expect(result.contexts[0].sourceDir).toBe(
                resolve(FIXTURE_CONFIG_ROOT, "string-context/packages/lecture/src")
            );
        });

    });

    describe("error handling", () => {
        it("should throw ConfigLoadError when contracts section is missing", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("missing-contracts");

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "Missing 'contracts' section in config"
            );
        });

        it("should throw error for non-existent config file", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("non-existent");

            await expect(configLoader.load(configPath)).rejects.toThrow();
        });

        it("should throw error for invalid glob pattern with multiple wildcards", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("packages-multi-wildcard");

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "Only single wildcard patterns"
            );
        });

        it("should throw ConfigLoadError for invalid entryStrategy", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("invalid-entry-strategy");

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                'Invalid contracts.entryStrategy: "file"'
            );
        });

        it("should accept safe-symbols dependencyStrategy", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-config-"));
            const configPath = join(root, "application.config.ts");
            await writeFile(
                configPath,
                `export default {
                    contracts: {
                        contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                        dependencyStrategy: "safe-symbols"
                    }
                };`
            );

            try {
                const result = await new ConfigLoader().load(configPath);

                expect(result.dependencyStrategy).toBe("safe-symbols");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should default missing dependencyStrategy to file", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("valid-config");

            const result = await configLoader.load(configPath);

            expect(result.dependencyStrategy).toBe("file");
        });

        it("should reject invalid dependencyStrategy", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-config-"));
            const configPath = join(root, "application.config.ts");
            await writeFile(
                configPath,
                `export default {
                    contracts: {
                        contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                        dependencyStrategy: "minimal"
                    }
                };`
            );

            try {
                await expect(new ConfigLoader().load(configPath)).rejects.toThrow(
                    'Invalid contracts.dependencyStrategy: "minimal". Expected "file" or "safe-symbols".'
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

    });

    describe("DecoratorNames configuration", () => {
        // Tests for configurable decorator names feature
        // The decoratorNames option allows users to specify custom decorator names
        // instead of the default @PublicEvent, @PublicCommand, @PublicQuery

        it("should use default decorator names when decoratorNames is not specified", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("valid-config");

            const result = await configLoader.load(configPath);

            // When decoratorNames is not specified, defaults should be used
            const expectedDefaults: DecoratorNames = {
                event: "PublicEvent",
                command: "PublicCommand",
                query: "PublicQuery",
            };
            expect(result.decoratorNames).toEqual(expectedDefaults);
        });

        it("should accept custom decorator names in config", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("custom-decorators");

            const result = await configLoader.load(configPath);

            // Custom decorator names should be loaded from config
            expect(result.decoratorNames).toEqual({
                event: "ContractEvent",
                command: "ContractCommand",
                query: "ContractQuery",
            });
        });

        it("should allow partial decorator names (use defaults for unspecified)", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("partial-decorators");

            const result = await configLoader.load(configPath);

            // Only event is customized, command and query should use defaults
            expect(result.decoratorNames).toEqual({
                event: "CustomEvent",
                command: "PublicCommand",
                query: "PublicQuery",
            });
        });
    });

    describe("ContractMarkerNames configuration", () => {
        it("should use default contract marker names when contractMarkerNames is not specified", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("valid-config");

            const result = await configLoader.load(configPath);

            const expectedDefaults: ContractMarkerNames = {
                contract: "PublicContract",
            };
            expect(result.contractMarkerNames).toEqual(expectedDefaults);
        });

        it("should accept custom contract marker names in config", async () => {
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("custom-contract-marker");

            const result = await configLoader.load(configPath);

            expect(result.contractMarkerNames).toEqual({
                contract: "SharedContract",
            });
        });
    });

    describe("trustedDecoratorSources configuration", () => {
        it("should load trusted decorator sources from config", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-config-"));
            const configPath = join(root, "application.config.ts");
            await writeFile(
                configPath,
                `export default {
                    contracts: {
                        contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                        trustedDecoratorSources: ["@app/contracts", "@shared/contracts"]
                    }
                };`
            );

            try {
                const result = await new ConfigLoader().load(configPath);

                expect(result.trustedDecoratorSources).toEqual([
                    "@app/contracts",
                    "@shared/contracts",
                ]);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should reject invalid trusted decorator sources", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-config-"));
            const configPath = join(root, "application.config.ts");
            await writeFile(
                configPath,
                `export default {
                    contracts: {
                        contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                        trustedDecoratorSources: ["@app/contracts", 42]
                    }
                };`
            );

            try {
                await expect(new ConfigLoader().load(configPath)).rejects.toThrow(
                    "Invalid contracts.trustedDecoratorSources: expected string array"
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    });

    describe("responseNamingConventions configuration", () => {
        // Tests for response naming conventions feature
        // This allows automatic matching of Response types to Command/Query messages
        // based on naming patterns (e.g., "CreateUserCommand" -> "CreateUserCommandResult")

        it("should load global responseNamingConventions into ContractsConfig", async () => {
            // Arrange
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("global-response-naming");

            // Act
            const result = await configLoader.load(configPath);

            // Assert - global responseNamingConventions should be present in the result
            expect(result.responseNamingConventions).toEqual([
                { messageSuffix: "Request", responseSuffix: "Response" },
                { messageSuffix: "Command", responseSuffix: "CommandResult" },
            ]);
        });

        it("should load context-level responseNamingConventions into ContextConfig", async () => {
            // Arrange
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("context-response-naming");

            // Act
            const result = await configLoader.load(configPath);

            // Assert - context-specific responseNamingConventions should be in the context config
            expect(result.contexts).toHaveLength(1);
            expect(result.contexts[0].responseNamingConventions).toEqual([
                { messageSuffix: "Command", responseSuffix: "Result" },
            ]);
        });

        it("should default responseNamingConventions to undefined when not specified (backward compatibility)", async () => {
            // Arrange
            const configLoader = new ConfigLoader();
            const configPath = fixtureConfigPath("valid-config");

            // Act
            const result = await configLoader.load(configPath);

            // Assert - missing responseNamingConventions should not cause errors
            // and should default to undefined (no automatic response matching)
            expect(result.responseNamingConventions).toBeUndefined();
            expect(result.contexts[0].responseNamingConventions).toBeUndefined();
        });
    });

    describe("outputs configuration", () => {
        async function writeTempConfig(config: object): Promise<{
            configPath: string;
            cleanup(): Promise<void>;
        }> {
            const root = await mkdtemp(join(tmpdir(), "contracts-config-"));
            const configPath = join(root, "application.config.ts");
            await writeFile(
                configPath,
                `export default ${JSON.stringify(config, null, 2)};`
            );

            return {
                configPath,
                cleanup: () => rm(root, { recursive: true, force: true }),
            };
        }

        it("should load output selection config", async () => {
            const temp = await writeTempConfig({
                contracts: {
                    contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                    outputs: [
                        {
                            name: "public",
                            path: "packages/contracts/src",
                            select: {
                                visibility: ["public"],
                                include: "all",
                                tags: { exclude: ["experimental"] },
                            },
                        },
                        {
                            name: "internal-commands",
                            path: "packages/contracts/src/internal",
                            registry: true,
                            select: {
                                visibility: ["internal"],
                                kinds: ["command"],
                                messageKinds: ["command"],
                                tags: { include: ["bus"] },
                            },
                        },
                    ],
                },
            });

            try {
                const result = await new ConfigLoader().load(temp.configPath);

                expect(result.configDir).toBe(resolve(temp.configPath, ".."));
                expect(result.outputs).toEqual([
                    {
                        name: "public",
                        path: "packages/contracts/src",
                        select: {
                            visibility: ["public"],
                            include: "all",
                            tags: { exclude: ["experimental"] },
                        },
                    },
                    {
                        name: "internal-commands",
                        path: "packages/contracts/src/internal",
                        registry: true,
                        select: {
                            visibility: ["internal"],
                            kinds: ["command"],
                            messageKinds: ["command"],
                            tags: { include: ["bus"] },
                        },
                    },
                ]);
            } finally {
                await temp.cleanup();
            }
        });

        it("should reject invalid output visibility", async () => {
            const temp = await writeTempConfig({
                contracts: {
                    contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                    outputs: [
                        {
                            name: "public",
                            path: "contracts",
                            select: { visibility: ["private"] },
                        },
                    ],
                },
            });

            try {
                await expect(new ConfigLoader().load(temp.configPath)).rejects.toThrow(
                    'Invalid contracts.outputs[0].select.visibility: "private"'
                );
            } finally {
                await temp.cleanup();
            }
        });

        it("should reject duplicate output names", async () => {
            const temp = await writeTempConfig({
                contracts: {
                    contexts: [{ name: "orders", path: ".", sourceDir: "." }],
                    outputs: [
                        { name: "public", path: "contracts/public" },
                        { name: "public", path: "contracts/public-copy" },
                    ],
                },
            });

            try {
                await expect(new ConfigLoader().load(temp.configPath)).rejects.toThrow(
                    'duplicate name "public"'
                );
            } finally {
                await temp.cleanup();
            }
        });
    });
});
