import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    ConfigLoadError,
    ConfigNotFoundError,
    findConfigFile,
    loadConfig,
    loadConfigFromPath,
} from "./config-loader";

describe("config-loader", () => {
    const testDir = path.join(__dirname, "__test-fixtures__");
    const nestedDir = path.join(testDir, "nested", "deep");

    beforeEach(() => {
        fs.mkdirSync(nestedDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe("findConfigFile", () => {
        it("should find hexai.config.ts in the current directory", () => {
            const configPath = path.join(testDir, "hexai.config.ts");
            fs.writeFileSync(configPath, "export default { plugins: [] };");

            const result = findConfigFile({ cwd: testDir });

            expect(result).toBe(configPath);
        });

        it("should find hexai.config.js when .ts is not present", () => {
            const configPath = path.join(testDir, "hexai.config.js");
            fs.writeFileSync(configPath, "module.exports = { plugins: [] };");

            const result = findConfigFile({ cwd: testDir });

            expect(result).toBe(configPath);
        });

        it("should find hexai.config.json when .ts and .js are not present", () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(configPath, '{ "plugins": [] }');

            const result = findConfigFile({ cwd: testDir });

            expect(result).toBe(configPath);
        });

        it("should prioritize .ts over .js", () => {
            const tsPath = path.join(testDir, "hexai.config.ts");
            const jsPath = path.join(testDir, "hexai.config.js");
            fs.writeFileSync(tsPath, "export default { plugins: [] };");
            fs.writeFileSync(jsPath, "module.exports = { plugins: [] };");

            const result = findConfigFile({ cwd: testDir });

            expect(result).toBe(tsPath);
        });

        it("should return null when no config file is found", () => {
            const result = findConfigFile({ cwd: testDir });

            expect(result).toBeNull();
        });

        it("should search parent directories when searchParents is true", () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(configPath, '{ "plugins": [] }');

            const result = findConfigFile({
                cwd: nestedDir,
                searchParents: true,
            });

            expect(result).toBe(configPath);
        });

        it("should not search parent directories by default", () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(configPath, '{ "plugins": [] }');

            const result = findConfigFile({ cwd: nestedDir });

            expect(result).toBeNull();
        });
    });

    describe("loadConfigFromPath", () => {
        it("should load and parse JSON config", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [
                        { plugin: "@hexaijs/plugin-a", config: {} },
                        {
                            plugin: "@hexaijs/plugin-b",
                            config: { key: "value" },
                        },
                    ],
                })
            );

            const config = await loadConfigFromPath(configPath);

            expect(config).toEqual({
                plugins: [
                    { plugin: "@hexaijs/plugin-a", config: {} },
                    { plugin: "@hexaijs/plugin-b", config: { key: "value" } },
                ],
            });
        });

        it("should throw ConfigLoadError for invalid JSON", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(configPath, "{ invalid json }");

            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                ConfigLoadError
            );
        });

        it("should throw ConfigLoadError when plugins array is missing", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(configPath, "{}");

            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                "plugins"
            );
        });

        it("should throw ConfigLoadError when plugin entry is not an object", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: ["@hexaijs/plugin-a"],
                })
            );

            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                "must be an object"
            );
        });

        it("should throw ConfigLoadError when plugin name is missing", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [{ config: {} }],
                })
            );

            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                "must be a non-empty string"
            );
        });

        it("should throw ConfigLoadError when config is missing", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [{ plugin: "@hexaijs/plugin-a" }],
                })
            );

            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                ConfigLoadError
            );
            await expect(loadConfigFromPath(configPath)).rejects.toThrow(
                "config is required"
            );
        });
    });

    describe("loadConfig", () => {
        it("should load config from current directory", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [{ plugin: "@hexaijs/plugin-test", config: {} }],
                })
            );

            const result = await loadConfig({ cwd: testDir });

            expect(result.config.plugins).toEqual([
                { plugin: "@hexaijs/plugin-test", config: {} },
            ]);
            expect(result.configPath).toBe(configPath);
        });

        it("should throw ConfigNotFoundError when no config file exists", async () => {
            await expect(loadConfig({ cwd: testDir })).rejects.toThrow(
                ConfigNotFoundError
            );
        });

        it("should include searched paths in ConfigNotFoundError", async () => {
            try {
                await loadConfig({ cwd: testDir });
                expect.fail("Should have thrown");
            } catch (error) {
                expect(error).toBeInstanceOf(ConfigNotFoundError);
                const message = (error as ConfigNotFoundError).message;
                expect(message).toContain("hexai.config.ts");
                expect(message).toContain("hexai.config.js");
                expect(message).toContain("hexai.config.json");
            }
        });

        it("should search parent directories when searchParents is true", async () => {
            const configPath = path.join(testDir, "hexai.config.json");
            fs.writeFileSync(
                configPath,
                JSON.stringify({
                    plugins: [{ plugin: "@hexaijs/plugin-parent", config: {} }],
                })
            );

            const result = await loadConfig({
                cwd: nestedDir,
                searchParents: true,
            });

            expect(result.config.plugins).toEqual([
                { plugin: "@hexaijs/plugin-parent", config: {} },
            ]);
            expect(result.configPath).toBe(configPath);
        });
    });
});
