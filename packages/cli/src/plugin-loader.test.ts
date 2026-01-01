import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    loadPlugin,
    loadPlugins,
    PluginExportError,
    PluginNotFoundError,
    PluginValidationError,
} from "./plugin-loader";

describe("plugin-loader", () => {
    const testDir = path.join(__dirname, "__test-plugin-fixtures__");

    beforeEach(() => {
        fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    function createMockPlugin(
        pluginDir: string,
        cliPluginContent: string | null
    ): string {
        fs.mkdirSync(pluginDir, { recursive: true });

        const packageJson = {
            name: path.basename(pluginDir),
            version: "1.0.0",
            main: "./index.js",
            type: "module",
        };
        fs.writeFileSync(
            path.join(pluginDir, "package.json"),
            JSON.stringify(packageJson, null, 2)
        );

        const indexContent =
            cliPluginContent !== null
                ? `export const cliPlugin = ${cliPluginContent};`
                : `export const someOtherExport = "hello";`;

        fs.writeFileSync(path.join(pluginDir, "index.js"), indexContent);

        return pluginDir;
    }

    function createPluginEntry(pluginPath: string, config: unknown = {}) {
        return { plugin: pluginPath, config };
    }

    describe("loadPlugin", () => {
        it("should load a valid plugin", async () => {
            const pluginDir = path.join(testDir, "valid-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    name: "test-command",
                    description: "A test command",
                    options: [],
                    run: async () => {},
                }`
            );

            const result = await loadPlugin(createPluginEntry(pluginDir));

            expect(result.pluginName).toBe(pluginDir);
            expect(result.plugin.name).toBe("test-command");
            expect(result.plugin.description).toBe("A test command");
            expect(result.plugin.options).toEqual([]);
            expect(typeof result.plugin.run).toBe("function");
        });

        it("should load a plugin with options", async () => {
            const pluginDir = path.join(testDir, "plugin-with-options");
            createMockPlugin(
                pluginDir,
                `{
                    name: "generate-contracts",
                    description: "Generate contracts",
                    options: [
                        {
                            flags: "-o, --output-dir <path>",
                            description: "Output directory",
                            required: true,
                        },
                        {
                            flags: "-c, --config <path>",
                            description: "Config file",
                            defaultValue: "app.config.ts",
                        },
                    ],
                    run: async (args) => console.log(args),
                }`
            );

            const result = await loadPlugin(createPluginEntry(pluginDir));

            expect(result.plugin.options).toHaveLength(2);
            expect(result.plugin.options[0].flags).toBe(
                "-o, --output-dir <path>"
            );
            expect(result.plugin.options[0].required).toBe(true);
            expect(result.plugin.options[1].defaultValue).toBe("app.config.ts");
        });

        it("should pass config through to result", async () => {
            const pluginDir = path.join(testDir, "plugin-with-config");
            createMockPlugin(
                pluginDir,
                `{
                    name: "test-command",
                    description: "A test command",
                    options: [],
                    run: async () => {},
                }`
            );

            const pluginConfig = { outputDir: "./dist", verbose: true };
            const result = await loadPlugin(
                createPluginEntry(pluginDir, pluginConfig)
            );

            expect(result.config).toEqual(pluginConfig);
        });

        it("should throw PluginNotFoundError when plugin doesn't exist", async () => {
            const nonExistentPlugin = path.join(testDir, "non-existent-plugin");

            await expect(
                loadPlugin(createPluginEntry(nonExistentPlugin))
            ).rejects.toThrow(PluginNotFoundError);
            await expect(
                loadPlugin(createPluginEntry(nonExistentPlugin))
            ).rejects.toThrow("not found");
        });

        it("should throw PluginExportError when cliPlugin is not exported", async () => {
            const pluginDir = path.join(testDir, "missing-export-plugin");
            createMockPlugin(pluginDir, null);

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginExportError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("does not export 'cliPlugin'");
        });

        it("should throw PluginValidationError when cliPlugin is not an object", async () => {
            const pluginDir = path.join(testDir, "invalid-type-plugin");
            createMockPlugin(pluginDir, `"not an object"`);

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("must be an object");
        });

        it("should throw PluginValidationError when name is missing", async () => {
            const pluginDir = path.join(testDir, "missing-name-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    description: "A test",
                    options: [],
                    run: async () => {},
                }`
            );

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("'name' must be a non-empty string");
        });

        it("should throw PluginValidationError when name is empty", async () => {
            const pluginDir = path.join(testDir, "empty-name-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    name: "",
                    description: "A test",
                    options: [],
                    run: async () => {},
                }`
            );

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("'name' must be a non-empty string");
        });

        it("should throw PluginValidationError when description is missing", async () => {
            const pluginDir = path.join(testDir, "missing-desc-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    name: "test",
                    options: [],
                    run: async () => {},
                }`
            );

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("'description' must be a string");
        });

        it("should throw PluginValidationError when options is not an array", async () => {
            const pluginDir = path.join(testDir, "invalid-options-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    name: "test",
                    description: "A test",
                    options: {},
                    run: async () => {},
                }`
            );

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("'options' must be an array");
        });

        it("should throw PluginValidationError when run is not a function", async () => {
            const pluginDir = path.join(testDir, "missing-run-plugin");
            createMockPlugin(
                pluginDir,
                `{
                    name: "test",
                    description: "A test",
                    options: [],
                    run: "not a function",
                }`
            );

            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow(PluginValidationError);
            await expect(
                loadPlugin(createPluginEntry(pluginDir))
            ).rejects.toThrow("'run' must be a function");
        });

        it("should include plugin name in PluginNotFoundError", async () => {
            const pluginName = "@hexaijs/non-existent-plugin";

            try {
                await loadPlugin(createPluginEntry(pluginName));
                expect.fail("Should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(PluginNotFoundError);
                expect((error as PluginNotFoundError).pluginName).toBe(
                    pluginName
                );
            }
        });

        it("should include plugin name in PluginExportError", async () => {
            const pluginDir = path.join(testDir, "export-error-plugin");
            createMockPlugin(pluginDir, null);

            try {
                await loadPlugin(createPluginEntry(pluginDir));
                expect.fail("Should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(PluginExportError);
                expect((error as PluginExportError).pluginName).toBe(pluginDir);
            }
        });

        it("should include plugin name and reason in PluginValidationError", async () => {
            const pluginDir = path.join(testDir, "validation-error-plugin");
            createMockPlugin(pluginDir, `null`);

            try {
                await loadPlugin(createPluginEntry(pluginDir));
                expect.fail("Should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(PluginValidationError);
                const validationError = error as PluginValidationError;
                expect(validationError.pluginName).toBe(pluginDir);
                expect(validationError.reason).toBe(
                    "cliPlugin must be an object"
                );
            }
        });
    });

    describe("loadPlugins", () => {
        it("should load multiple valid plugins", async () => {
            const plugin1Dir = path.join(testDir, "plugin-1");
            const plugin2Dir = path.join(testDir, "plugin-2");

            createMockPlugin(
                plugin1Dir,
                `{
                    name: "command-1",
                    description: "First command",
                    options: [],
                    run: async () => {},
                }`
            );
            createMockPlugin(
                plugin2Dir,
                `{
                    name: "command-2",
                    description: "Second command",
                    options: [],
                    run: async () => {},
                }`
            );

            const results = await loadPlugins([
                createPluginEntry(plugin1Dir),
                createPluginEntry(plugin2Dir),
            ]);

            expect(results).toHaveLength(2);
            expect(results[0].plugin.name).toBe("command-1");
            expect(results[1].plugin.name).toBe("command-2");
        });

        it("should return empty array for empty input", async () => {
            const results = await loadPlugins([]);

            expect(results).toEqual([]);
        });

        it("should throw on first invalid plugin", async () => {
            const validPluginDir = path.join(testDir, "valid-plugin");
            const invalidPluginDir = path.join(testDir, "invalid-plugin");

            createMockPlugin(
                validPluginDir,
                `{
                    name: "valid",
                    description: "Valid",
                    options: [],
                    run: async () => {},
                }`
            );
            createMockPlugin(invalidPluginDir, null);

            await expect(
                loadPlugins([
                    createPluginEntry(validPluginDir),
                    createPluginEntry(invalidPluginDir),
                ])
            ).rejects.toThrow(PluginExportError);
        });

        it("should preserve order of loaded plugins", async () => {
            const pluginDirs = ["plugin-a", "plugin-b", "plugin-c"].map(
                (name) => path.join(testDir, name)
            );

            for (const pluginDir of pluginDirs) {
                const commandName = path.basename(pluginDir);
                createMockPlugin(
                    pluginDir,
                    `{
                        name: "${commandName}",
                        description: "Command ${commandName}",
                        options: [],
                        run: async () => {},
                    }`
                );
            }

            const results = await loadPlugins(
                pluginDirs.map((dir) => createPluginEntry(dir))
            );

            expect(results.map((r) => r.plugin.name)).toEqual([
                "plugin-a",
                "plugin-b",
                "plugin-c",
            ]);
        });
    });
});
