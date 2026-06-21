import { execSync } from "node:child_process";
import * as path from "node:path";

import { describe, expect, test } from "vitest";

import { makeContext, useContext } from "./test.js";

const CLI_PATH = path.join(__dirname, "../dist/cli.js");
const EXIT_CODE_ERROR = 1;

describe.sequential("Build Plugin CLI", () => {
    const sampleContext = useContext("sample-context");

    function runCliWithContext(contextPath: string, args: string[] = []) {
        return execSync(
            `node ${CLI_PATH} --context-path ${contextPath} ${args.join(" ")}`,
            {
                encoding: "utf-8",
            }
        );
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

    test("supports extensionless generated imports with --output-module-specifiers", () => {
        const cliOutput = runCliWithContext(sampleContext.path, [
            "--output-module-specifiers",
            "extensionless",
        ]);

        expectSuccessfulBuildOutput(cliOutput);
        sampleContext.expectOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler'",
            "import { CreateUserCommand } from '../create-user.command'"
        );
        sampleContext.expectOutputFileNotToContain(
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.command.js'"
        );
    });

    test("exits with code 1 when --output-module-specifiers is invalid", () => {
        try {
            runCliWithContext(sampleContext.path, [
                "--output-module-specifiers",
                "cjs",
            ]);
            expect.fail("CLI should have exited with code 1");
        } catch (error: unknown) {
            expect((error as { status: number }).status).toBe(EXIT_CODE_ERROR);
            expect(String((error as { stderr: Buffer }).stderr)).toContain(
                'Expected "js" or "extensionless".'
            );
        }
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
