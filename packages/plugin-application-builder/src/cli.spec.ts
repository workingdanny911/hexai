import { describe, test, expect } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { makeContext, useContext } from "./test";

const CLI_PATH = path.join(__dirname, "../dist/cli.js");
const EXIT_CODE_ERROR = 1;

describe.sequential("Build Plugin CLI", () => {
    const sampleContext = useContext("sample-context");

    function runCliWithContext(contextPath: string) {
        return execSync(`node ${CLI_PATH} --context-path ${contextPath}`, {
            encoding: "utf-8",
        });
    }

    function expectSuccessfulBuildOutput(cliOutput: string) {
        expect(cliOutput).toContain("Generating application builder for:");
        expect(cliOutput).toContain("Application builder generated successfully");
    }

    test("generates builder when invoked with --context-path", () => {
        const cliOutput = runCliWithContext(sampleContext.path);

        expectSuccessfulBuildOutput(cliOutput);
        sampleContext.expectOutputFileToExist();
    });

    test("exits with code 1 when context has no config file", () => {
        const missingContextPath = path.join("./fixtures/non-existent-context");

        try {
            runCliWithContext(missingContextPath);
            expect.fail("CLI should have exited with code 1");
        } catch (error: unknown) {
            // execSync throws when command exits with non-zero status
            expect((error as { status: number }).status).toBe(EXIT_CODE_ERROR);
        }
    });

    test("generates empty builder for context with no handlers", () => {
        const emptyContext = makeContext("empty-context");
        emptyContext.cleanUp();

        try {
            const cliOutput = runCliWithContext(emptyContext.path);

            expectSuccessfulBuildOutput(cliOutput);
            emptyContext.expectOutputFileToContain(
                "export function createApplicationBuilder()",
                "return new ApplicationBuilder();"
            );
        } finally {
            emptyContext.cleanUp();
        }
    });
});
