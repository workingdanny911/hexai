import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { run } from "@/cli";

describe("Packages Glob Pattern E2E", () => {
    const fixturesDir = join(__dirname, "..", "fixtures", "packages-glob");
    let outputDir: string;
    let configPath: string;

    beforeEach(async () => {
        const runId = randomBytes(4).toString("hex");
        outputDir = join(__dirname, "..", "output", `packages-glob-${runId}`);
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

    describe("packages glob expansion", () => {
        it("should expand packages/* pattern to multiple contexts", async () => {
            const config = {
                contracts: {
                    contexts: [fixturesDir + "/*"],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "orders"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory"))).toBe(true);
        });

        it("should generate correct files for each matched package", async () => {
            const config = {
                contracts: {
                    contexts: [fixturesDir + "/*"],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "orders", "index.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "orders", "events.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "orders", "commands.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "orders", "types.ts"))).toBe(true);

            expect(existsSync(join(contractsDir, "inventory", "index.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory", "events.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory", "commands.ts"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory", "types.ts"))).toBe(true);
        });
    });

    describe("packages with pathAliasRewrites", () => {
        it("should apply pathAliasRewrites to generated files", async () => {
            const config = {
                contracts: {
                    contexts: [fixturesDir + "/*"],
                    pathAliasRewrites: {
                        "@/decorators": "@libera/decorators",
                    },
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const ordersEvents = await readFile(
                join(contractsDir, "orders", "events.ts"),
                "utf-8"
            );
            expect(ordersEvents).toContain("@libera/decorators");
            expect(ordersEvents).not.toContain("@/decorators");
        });
    });

    describe("packages with contexts combined", () => {
        it("should combine explicit contexts with string contexts", async () => {
            const config = {
                contracts: {
                    contexts: [
                        {
                            name: "explicit-orders",
                            sourceDir: join(fixturesDir, "orders", "src"),
                        },
                        fixturesDir + "/*",
                    ],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            expect(existsSync(join(contractsDir, "explicit-orders"))).toBe(true);
            expect(existsSync(join(contractsDir, "inventory"))).toBe(true);
            expect(existsSync(join(contractsDir, "orders"))).toBe(true);
        });
    });

    describe("barrel export generation", () => {
        it("should generate barrel export with correct exports", async () => {
            const config = {
                contracts: {
                    contexts: [fixturesDir + "/*"],
                },
            };

            await createConfig(config);
            const contractsDir = join(outputDir, "contracts");
            await run(["--config", configPath, "--output-dir", contractsDir]);

            const ordersIndex = await readFile(
                join(contractsDir, "orders", "index.ts"),
                "utf-8"
            );
            expect(ordersIndex).toContain("export *");
            expect(ordersIndex).toContain("events");
            expect(ordersIndex).toContain("commands");
        });
    });
});
