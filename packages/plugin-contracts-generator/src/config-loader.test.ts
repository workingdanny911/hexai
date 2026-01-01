import { describe, it, expect } from "vitest";
import { resolve } from "path";

import { ConfigLoader, ConfigLoadError } from "./config-loader";
import type { DecoratorNames } from "./domain";

describe("ConfigLoader", () => {
    describe("object context format", () => {
        it("should load contracts config from a valid config file", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/valid-config/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(1);
            expect(result.contexts[0]).toEqual({
                name: "lecture",
                sourceDir: "src",
            });
            expect(result.pathAliasRewrites).toEqual({
                "@/": "@libera/",
            });
        });

        it("should throw ConfigLoadError when context has missing required fields", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/invalid-contexts/application.config.ts";

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "missing 'sourceDir'"
            );
        });

        it("should load multiple contexts", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/multi-context/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(2);
            expect(result.contexts[0].name).toBe("lecture");
            expect(result.contexts[1].name).toBe("video-lesson");
        });

        it("should load multiple pathAliasRewrites", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/multi-context/application.config.ts";

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
            const configPath =
                "test/fixtures/config/string-context/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(1);
            expect(result.contexts[0].name).toBe("lecture");
            expect(result.contexts[0].sourceDir).toContain("packages/lecture/src");
            expect(result.contexts[0].tsconfigPath).toContain("packages/lecture/tsconfig.json");
        });

        it("should include pathAliasRewrites from root config", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/string-context/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.pathAliasRewrites).toEqual({
                "@/": "@libera/",
            });
        });

        it("should expand glob pattern in contexts array", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/string-context-glob/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.contexts).toHaveLength(2);
            expect(result.contexts.map((c) => c.name).sort()).toEqual([
                "lecture",
                "video-lesson",
            ]);
        });

        it("should resolve sourceDir relative to package directory", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/string-context/application.config.ts";

            const result = await configLoader.load(configPath);

            expect(result.contexts[0].sourceDir).toBe(
                resolve("test/fixtures/config/string-context/packages/lecture/src")
            );
        });

        it("should throw error when package has no application.config.ts", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/packages-glob/application.config.ts";

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "Missing application.config.ts"
            );
        });
    });

    describe("error handling", () => {
        it("should throw ConfigLoadError when contracts section is missing", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/missing-contracts/application.config.ts";

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "Missing 'contracts' section in config"
            );
        });

        it("should throw error for non-existent config file", async () => {
            const configLoader = new ConfigLoader();
            const configPath = "test/fixtures/config/non-existent/application.config.ts";

            await expect(configLoader.load(configPath)).rejects.toThrow();
        });

        it("should throw error for invalid glob pattern with multiple wildcards", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/packages-multi-wildcard/application.config.ts";

            await expect(configLoader.load(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(configLoader.load(configPath)).rejects.toThrow(
                "Only single wildcard patterns"
            );
        });

    });

    describe("DecoratorNames configuration", () => {
        // Tests for configurable decorator names feature
        // The decoratorNames option allows users to specify custom decorator names
        // instead of the default @PublicEvent, @PublicCommand, @PublicQuery

        it("should use default decorator names when decoratorNames is not specified", async () => {
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/valid-config/application.config.ts";

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
            const configPath =
                "test/fixtures/config/custom-decorators/application.config.ts";

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
            const configPath =
                "test/fixtures/config/partial-decorators/application.config.ts";

            const result = await configLoader.load(configPath);

            // Only event is customized, command and query should use defaults
            expect(result.decoratorNames).toEqual({
                event: "CustomEvent",
                command: "PublicCommand",
                query: "PublicQuery",
            });
        });
    });

    describe("responseNamingConventions configuration", () => {
        // Tests for response naming conventions feature
        // This allows automatic matching of Response types to Command/Query messages
        // based on naming patterns (e.g., "CreateUserCommand" -> "CreateUserCommandResult")

        it("should load global responseNamingConventions into ContractsConfig", async () => {
            // Arrange
            const configLoader = new ConfigLoader();
            const configPath =
                "test/fixtures/config/global-response-naming/application.config.ts";

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
            const configPath =
                "test/fixtures/config/context-response-naming/application.config.ts";

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
            const configPath =
                "test/fixtures/config/valid-config/application.config.ts";

            // Act
            const result = await configLoader.load(configPath);

            // Assert - missing responseNamingConventions should not cause errors
            // and should default to undefined (no automatic response matching)
            expect(result.responseNamingConventions).toBeUndefined();
            expect(result.contexts[0].responseNamingConventions).toBeUndefined();
        });
    });
});
