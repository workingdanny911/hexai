import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { TsconfigLoader } from "./tsconfig-loader";

describe("TsconfigLoader", () => {
    const testDir = join(__dirname, "../test/fixtures/tsconfig-test");

    beforeEach(() => {
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it("should load paths from tsconfig.json", async () => {
        const tsconfigPath = join(testDir, "tsconfig.json");
        writeFileSync(
            tsconfigPath,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: {
                        "@/*": ["src/*"],
                    },
                },
            })
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(tsconfigPath);

        expect(config.paths.get("@/*")).toEqual([join(testDir, "src/*")]);
    });

    it("should resolve baseUrl relative to tsconfig location", async () => {
        const tsconfigPath = join(testDir, "tsconfig.json");
        writeFileSync(
            tsconfigPath,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: "./src",
                    paths: {
                        "@/*": ["*"],
                    },
                },
            })
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(tsconfigPath);

        expect(config.baseUrl).toBe(join(testDir, "src"));
        expect(config.paths.get("@/*")).toEqual([join(testDir, "src/*")]);
    });

    it("should inherit paths from extended config", async () => {
        const baseConfigPath = join(testDir, "tsconfig.base.json");
        const childConfigPath = join(testDir, "tsconfig.json");

        writeFileSync(
            baseConfigPath,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: {
                        "@shared/*": ["shared/*"],
                    },
                },
            })
        );

        writeFileSync(
            childConfigPath,
            JSON.stringify({
                extends: "./tsconfig.base.json",
                compilerOptions: {
                    paths: {
                        "@/*": ["src/*"],
                    },
                },
            })
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(childConfigPath);

        expect(config.paths.get("@/*")).toEqual([join(testDir, "src/*")]);
    });

    it("should handle multiple path targets", async () => {
        const tsconfigPath = join(testDir, "tsconfig.json");
        writeFileSync(
            tsconfigPath,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: {
                        "@/*": ["src/*", "lib/*"],
                    },
                },
            })
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(tsconfigPath);

        expect(config.paths.get("@/*")).toEqual([
            join(testDir, "src/*"),
            join(testDir, "lib/*"),
        ]);
    });

    it("should return empty paths when no paths configured", async () => {
        const tsconfigPath = join(testDir, "tsconfig.json");
        writeFileSync(
            tsconfigPath,
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                },
            })
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(tsconfigPath);

        expect(config.paths.size).toBe(0);
    });

    it("should handle JSON with comments", async () => {
        const tsconfigPath = join(testDir, "tsconfig.json");
        writeFileSync(
            tsconfigPath,
            `{
                // This is a comment
                "compilerOptions": {
                    "baseUrl": ".",
                    /* Multi-line
                       comment */
                    "paths": {
                        "@/*": ["src/*"]
                    }
                }
            }`
        );

        const loader = new TsconfigLoader();
        const config = await loader.load(tsconfigPath);

        expect(config.paths.get("@/*")).toEqual([join(testDir, "src/*")]);
    });
});
