import { describe, it, expect, vi } from "vitest";
import path from "path";

import { ContextConfig } from "./context-config";
import type { FileSystem } from "./file-system";

describe("ContextConfig", () => {
    describe("createSync", () => {
        it("should create ContextConfig without tsconfig", () => {
            const sourceDir = "/some/path/src";
            const config = ContextConfig.createSync("test-context", sourceDir);

            expect(config.name).toBe("test-context");
            expect(config.sourceDir).toBe(sourceDir);
        });

        it("should include responseNamingConventions when provided", () => {
            const conventions = [{ messageSuffix: "Command", responseSuffix: "Result" }];
            const config = ContextConfig.createSync(
                "test-context",
                "/some/path",
                undefined,
                conventions
            );

            expect(config.responseNamingConventions).toEqual(conventions);
        });
    });

    describe("create", () => {
        const fixtureRoot = path.resolve(__dirname, "../e2e/fixtures/path-alias");

        it("should create ContextConfig with resolved sourceDir from path", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                    sourceDir: "src",
                },
                fixtureRoot
            );

            expect(config.name).toBe("test");
            expect(config.sourceDir).toBe(path.join(fixtureRoot, "src"));
        });

        it("should use default sourceDir 'src' when not specified", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                },
                fixtureRoot
            );

            expect(config.sourceDir).toBe(path.join(fixtureRoot, "src"));
        });

        it("should throw error when name is missing", async () => {
            await expect(
                ContextConfig.create(
                    { name: "", path: "." },
                    fixtureRoot
                )
            ).rejects.toThrow("ContextConfig requires 'name'");
        });

        it("should throw error when path is missing", async () => {
            await expect(
                ContextConfig.create(
                    { name: "test", path: "" },
                    fixtureRoot
                )
            ).rejects.toThrow("ContextConfig 'test' requires 'path'");
        });

        it("should auto-detect tsconfig.json when it exists", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                },
                fixtureRoot
            );

            const result = await config.resolvePath("@/decorators");
            expect(result.isExternal).toBe(false);
        });

        it("should use Tsconfig.NONE when tsconfig does not exist", async () => {
            const mockFs: FileSystem = {
                exists: vi.fn().mockResolvedValue(false),
                readFile: vi.fn(),
                readdir: vi.fn(),
                writeFile: vi.fn(),
                mkdir: vi.fn(),
                stat: vi.fn(),
            };

            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                },
                "/nonexistent/path",
                mockFs
            );

            const result = await config.resolvePath("@/something");
            expect(result.isExternal).toBe(true);
        });

        it("should load explicit tsconfigPath when provided", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                    tsconfigPath: "tsconfig.json",
                },
                fixtureRoot
            );

            expect(config.name).toBe("test");
            expect(config.sourceDir).toBe(path.join(fixtureRoot, "src"));
        });
    });

    describe("resolvePath", () => {
        const fixtureRoot = path.resolve(__dirname, "../e2e/fixtures/path-alias");
        const srcRoot = path.join(fixtureRoot, "src");

        it("should resolve path alias to file path", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                    sourceDir: "src",
                    tsconfigPath: "tsconfig.json",
                },
                fixtureRoot
            );

            const result = await config.resolvePath("@/decorators");

            expect(result.isExternal).toBe(false);
            expect(result.resolvedPath).toBe(path.join(srcRoot, "decorators/index.ts"));
        });

        it("should return external for unmatched module specifier", async () => {
            const config = await ContextConfig.create(
                {
                    name: "test",
                    path: ".",
                    sourceDir: "src",
                    tsconfigPath: "tsconfig.json",
                },
                fixtureRoot
            );

            const result = await config.resolvePath("@hexaijs/core");

            expect(result.isExternal).toBe(true);
            expect(result.resolvedPath).toBeNull();
        });

        it("should return external when no tsconfig loaded", async () => {
            const config = ContextConfig.createSync("test", srcRoot);

            const result = await config.resolvePath("@/decorators");

            expect(result.isExternal).toBe(true);
            expect(result.resolvedPath).toBeNull();
        });
    });
});
