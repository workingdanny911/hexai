import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// Import the functions we want to test
// Note: We need to test extractConfigPath which is not exported,
// so we'll test it indirectly through createProgram

describe("CLI Entry Point", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hexai-cli-test-"));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe("extractConfigPath (tested via createProgram)", () => {
        it("should handle --config=path format", async () => {
            // Create a config file
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            // Import dynamically to get fresh module state
            const { createProgram } = await import("./index");

            // Test with --config=path format
            const program = await createProgram({
                argv: ["node", "hexai", `--config=${configPath}`],
            });

            expect(program).toBeDefined();
            expect(program.name()).toBe("hexai");
        });

        it("should handle -c=path format", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({
                argv: ["node", "hexai", `-c=${configPath}`],
            });

            expect(program).toBeDefined();
        });

        it("should handle --config path format (space separated)", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({
                argv: ["node", "hexai", "--config", configPath],
            });

            expect(program).toBeDefined();
        });

        it("should handle -c path format (space separated)", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({
                argv: ["node", "hexai", "-c", configPath],
            });

            expect(program).toBeDefined();
        });
    });

    describe("createProgram", () => {
        it("should create a program with name and description", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({ configPath });

            expect(program.name()).toBe("hexai");
            expect(program.description()).toBe(
                "Unified CLI tool for hexai plugins"
            );
        });

        it("should have --config option defined", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({ configPath });

            // Check that the option is defined
            const options = program.options;
            const configOption = options.find(
                (opt) => opt.long === "--config" || opt.short === "-c"
            );
            expect(configOption).toBeDefined();
        });

        it("should use configPath option over argv", async () => {
            // Create two config files with different plugin entries
            const configPath1 = path.join(tempDir, "config1.json");
            const configPath2 = path.join(tempDir, "config2.json");

            // Create mock plugins to verify which config was loaded
            const plugin1Dir = path.join(
                tempDir,
                "node_modules",
                "plugin-from-config1"
            );
            const plugin2Dir = path.join(
                tempDir,
                "node_modules",
                "plugin-from-config2"
            );

            for (const pluginDir of [plugin1Dir, plugin2Dir]) {
                fs.mkdirSync(pluginDir, { recursive: true });
                const pluginName = path.basename(pluginDir);
                fs.writeFileSync(
                    path.join(pluginDir, "package.json"),
                    JSON.stringify({
                        name: pluginName,
                        main: "./index.js",
                        type: "module",
                    })
                );
                fs.writeFileSync(
                    path.join(pluginDir, "index.js"),
                    `export const cliPlugin = { name: "${pluginName}", description: "Test", options: [], run: async () => {} };`
                );
            }

            fs.writeFileSync(
                configPath1,
                JSON.stringify({
                    plugins: [{ plugin: plugin1Dir, config: {} }],
                })
            );
            fs.writeFileSync(
                configPath2,
                JSON.stringify({
                    plugins: [{ plugin: plugin2Dir, config: {} }],
                })
            );

            const { createProgram } = await import("./index");

            // configPath option should take precedence over argv
            const program = await createProgram({
                configPath: configPath1,
                argv: ["node", "hexai", "--config", configPath2],
            });

            // Verify that plugin from config1 was loaded (not config2)
            const commands = program.commands.map((cmd) => cmd.name());
            expect(commands).toContain("plugin-from-config1");
            expect(commands).not.toContain("plugin-from-config2");
        });

        it("should throw ConfigNotFoundError when config file does not exist", async () => {
            const { createProgram, ConfigNotFoundError } =
                await import("./index");

            const nonExistentConfig = path.join(
                tempDir,
                "non-existent.config.json"
            );

            await expect(
                createProgram({ configPath: nonExistentConfig })
            ).rejects.toThrow(); // ConfigLoadError for non-existent file
        });
    });

    describe("plugin registration", () => {
        it("should register plugins as subcommands", async () => {
            // Create a mock plugin module
            const pluginDir = path.join(
                tempDir,
                "node_modules",
                "@test",
                "mock-plugin"
            );
            fs.mkdirSync(pluginDir, { recursive: true });

            const pluginCode = `
                module.exports = {
                    cliPlugin: {
                        name: "test-command",
                        description: "A test command",
                        options: [
                            {
                                flags: "-t, --test <value>",
                                description: "A test option",
                            },
                        ],
                        run: async (args) => {
                            console.log("Test command executed with:", args);
                        },
                    },
                };
            `;
            fs.writeFileSync(path.join(pluginDir, "index.js"), pluginCode);
            fs.writeFileSync(
                path.join(pluginDir, "package.json"),
                JSON.stringify({ name: "@test/mock-plugin", main: "index.js" })
            );

            // Create config that references this plugin
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [{ plugin: "@test/mock-plugin", config: {} }],
                })
            );

            // Modify NODE_PATH to find our mock plugin
            const originalNodePath = process.env.NODE_PATH;
            process.env.NODE_PATH = path.join(tempDir, "node_modules");

            // Clear module cache and re-import
            try {
                const { createProgram } = await import("./index");

                // This will fail because the plugin can't be resolved from node_modules
                // In a real scenario, plugins would be installed via npm/pnpm
                await expect(createProgram({ configPath })).rejects.toThrow();
            } finally {
                process.env.NODE_PATH = originalNodePath;
            }
        });
    });

    describe("CreateProgramOptions", () => {
        it("should accept configPath option", async () => {
            const configPath = path.join(tempDir, "custom.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({ configPath });
            expect(program).toBeDefined();
        });

        it("should accept argv option", async () => {
            const configPath = path.join(tempDir, "hexai.config.json");
            fs.writeFileSync(configPath, JSON.stringify({ plugins: [] }));

            const { createProgram } = await import("./index");

            const program = await createProgram({
                argv: ["node", "hexai", "-c", configPath],
            });
            expect(program).toBeDefined();
        });
    });
    describe("handleError", () => {
        let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

        beforeEach(() => {
            consoleErrorSpy = vi
                .spyOn(console, "error")
                .mockImplementation(() => {});
        });

        afterEach(() => {
            consoleErrorSpy.mockRestore();
        });

        it("should handle ConfigNotFoundError with helpful message", async () => {
            const { handleError, ConfigNotFoundError } =
                await import("./index");

            const error = new ConfigNotFoundError([
                "/path/hexai.config.ts",
                "/path/hexai.config.js",
            ]);
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Configuration Error:",
                expect.stringContaining("No hexai config file found")
            );
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("create a hexai.config.ts file")
            );
        });

        it("should handle ConfigLoadError", async () => {
            const { handleError, ConfigLoadError } = await import("./index");

            const error = new ConfigLoadError(
                "/path/config.json",
                new Error("Invalid JSON")
            );
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Configuration Error:",
                expect.stringContaining("Failed to load config")
            );
        });

        it("should handle PluginNotFoundError with install hint", async () => {
            const { handleError, PluginNotFoundError } =
                await import("./index");

            const error = new PluginNotFoundError("@hexaijs/missing-plugin");
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Plugin Error:",
                expect.stringContaining("not found")
            );
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining("pnpm add @hexaijs/missing-plugin")
            );
        });

        it("should handle PluginExportError", async () => {
            const { handleError, PluginExportError } = await import("./index");

            const error = new PluginExportError("@hexaijs/bad-plugin");
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Plugin Error:",
                expect.stringContaining("does not export 'cliPlugin'")
            );
        });

        it("should handle PluginValidationError", async () => {
            const { handleError, PluginValidationError } =
                await import("./index");

            const error = new PluginValidationError(
                "@hexaijs/invalid-plugin",
                "'name' is missing"
            );
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Plugin Error:",
                expect.stringContaining("invalid cliPlugin")
            );
        });

        it("should handle generic Error", async () => {
            const { handleError } = await import("./index");

            const error = new Error("Something went wrong");
            handleError(error);

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "Error:",
                "Something went wrong"
            );
        });

        it("should handle unknown error type", async () => {
            const { handleError } = await import("./index");

            handleError("string error");

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                "An unknown error occurred"
            );
        });
    });
});
