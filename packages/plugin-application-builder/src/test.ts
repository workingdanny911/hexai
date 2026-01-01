import * as path from "node:path";
import * as fs from "node:fs";

import { beforeEach, expect } from "vitest";

import { generateApplicationBuilder } from "./main";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const GENERATED_DIR = "src/.generated";
const OUTPUT_FILENAME = "application-builder.ts";
const DEFAULT_CONFIG_FILE = "hexai.config.ts";

export interface TestContext {
    readonly path: string;
    readonly outputDir: string;
    readonly outputFile: string;
    generate(): Promise<void>;
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
    return {
        path: getContextPath(name),
        outputDir: getOutputDir(getContextPath(name)),
        outputFile: getOutputFile(getContextPath(name)),
        generate() {
            return generateApplicationBuilder(this.path, {
                configFile: DEFAULT_CONFIG_FILE,
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

export function useContext(name: string): TestContext {
    const context = makeContext(name);

    beforeEach(() => {
        context.cleanUp();

        return () => {
            context.cleanUp();
        };
    });

    return context;
}
