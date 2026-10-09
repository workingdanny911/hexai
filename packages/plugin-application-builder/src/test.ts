import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { afterAll, beforeEach, expect } from "vitest";

import { generateApplicationBuilder } from "./main.js";

import type { GenerateApplicationBuilderOptions } from "./main.js";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const GENERATED_DIR = "src/.generated";
const OUTPUT_FILENAME = "application-builder.ts";
const DEFAULT_CONFIG_FILE = "hexai.config.ts";

export interface TestContext {
    readonly path: string;
    readonly outputDir: string;
    readonly outputFile: string;
    generate(
        options?: Omit<GenerateApplicationBuilderOptions, "configFile">
    ): Promise<void>;
    cleanUp(): void;
    isOutputFilePresent(): boolean;
    expectOutputFileToExist(): void;
    expectOutputFileToContain(...strings: string[]): void;
    expectOutputFileNotToContain(...strings: string[]): void;
    getOutputFileContent(): string;
}

function getContextPath(contextName: string) {
    return path.join(FIXTURES_DIR, contextName);
}

function getOutputDir(contextPath: string) {
    return path.join(contextPath, GENERATED_DIR);
}

function getOutputFile(contextPath: string) {
    return path.join(getOutputDir(contextPath), OUTPUT_FILENAME);
}

export function makeContext(name: string): TestContext {
    return createContextAt(getContextPath(name));
}

function createContextAt(contextPath: string): TestContext {
    return {
        path: contextPath,
        outputDir: getOutputDir(contextPath),
        outputFile: getOutputFile(contextPath),
        generate(options = {}) {
            return generateApplicationBuilder(this.path, {
                configFile: DEFAULT_CONFIG_FILE,
                ...options,
            });
        },
        cleanUp() {
            if (fs.existsSync(this.outputFile)) {
                fs.unlinkSync(this.outputFile);
            }
            if (fs.existsSync(this.outputDir)) {
                fs.rmdirSync(this.outputDir);
            }
        },
        isOutputFilePresent() {
            return fs.existsSync(this.outputFile);
        },
        expectOutputFileToExist() {
            expect(
                this.isOutputFilePresent(),
                `Output file ${this.outputFile} does not exist`
            ).toBe(true);
        },
        expectOutputFileToContain(...strings: string[]) {
            this.expectOutputFileToExist();

            const content = this.getOutputFileContent();
            strings.forEach((s) => expect(content).toContain(s));
        },
        expectOutputFileNotToContain(...strings: string[]) {
            this.expectOutputFileToExist();

            const content = this.getOutputFileContent();
            strings.forEach((s) => expect(content).not.toContain(s));
        },
        getOutputFileContent() {
            return fs.readFileSync(this.outputFile, "utf-8");
        },
    };
}

// Spec files run in parallel, so each call works on its own copy of the
// fixture: no two spec files write or delete the same generated file.
export function useContext(name: string): TestContext {
    const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hexai-fixture-"));
    const contextPath = path.join(copyRoot, name);
    fs.cpSync(getContextPath(name), contextPath, { recursive: true });
    const context = createContextAt(contextPath);

    afterAll(() => {
        fs.rmSync(copyRoot, { recursive: true, force: true });
    });

    beforeEach(() => {
        context.cleanUp();

        return () => {
            context.cleanUp();
        };
    });

    return context;
}
