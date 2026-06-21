import * as path from "node:path";

import { ApplicationBuilder } from "@hexaijs/application";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";

import { makeContext, useContext } from "./test.js";

describe.sequential("Build Plugin - Application Builder Generation", () => {
    const sampleContext = useContext("sample-context");
    const orderContext = useContext("order-context");
    const emptyContext = useContext("empty-context");
    const pathAliasContext = useContext("path-alias-context");
    const queryHandlerContext = useContext("query-handler-context");
    const sameFileContext = useContext("same-file-context");
    const nodeNextContext = useContext("nodenext-context");

    test("generates builder file from decorated handlers", async () => {
        await sampleContext.generate();

        sampleContext.expectOutputFileToExist();
    });

    // Command handler registration tests - parameterized
    test.each([
        [
            "CreateUser",
            "create-user.handler",
            "create-user.command",
            "CreateUserHandler",
            "CreateUserCommand",
        ],
        [
            "UpdateUser",
            "update-user.handler",
            "update-user.command",
            "UpdateUserHandler",
            "UpdateUserCommand",
        ],
    ])(
        "generates builder with %s command handler",
        async (_name, handlerFile, commandFile, handlerClass, commandClass) => {
            await sampleContext.generate();

            sampleContext.expectOutputFileToContain(
                `import { ${handlerClass} } from '../${handlerFile}.js'`,
                `import { ${commandClass} } from '../${commandFile}.js'`,
                `.withCommandHandler(${commandClass}, () => new ${handlerClass}())`
            );
        }
    );

    test("generates builder with event handler registration", async () => {
        await sampleContext.generate();

        sampleContext.expectOutputFileToContain(
            "import { UserCreatedEventHandler } from '../user-created.handler.js'",
            ".withEventHandler(() => new UserCreatedEventHandler(), 'user-created')"
        );
    });

    test("exports builder factory function that returns ApplicationBuilder", async () => {
        await sampleContext.generate();

        // Cache busting: bypass Node.js module cache with timestamp query parameter
        const { createApplicationBuilder } = await import(
            `${sampleContext.outputFile}?t=${Date.now()}`
        );

        const builder = createApplicationBuilder();

        expect(builder).toBeInstanceOf(ApplicationBuilder);
    });

    test("generates builder for different context", async () => {
        await orderContext.generate();

        orderContext.expectOutputFileToContain(
            "export function createApplicationBuilder()",
            "import { CreateOrderHandler } from '../create-order.handler.js'",
            ".withCommandHandler(CreateOrderCommand, () => new CreateOrderHandler())"
        );
    });

    // Error handling tests - parameterized
    test.each([
        [
            "invalid-event-handler",
            "EventHandler has invalid options",
            /EventHandler for InvalidEventHandler has invalid options: invalidOption/,
        ],
        [
            "duplicate-command-handler",
            "multiple handlers exist for the same command",
            /Duplicate command handlers for "CreateUserCommand"/,
        ],
        [
            "duplicate-event-handler",
            "multiple event handlers have the same name",
            /Duplicate event handlers for event "user-created"/,
        ],
        [
            "duplicate-query-handler",
            "multiple handlers exist for the same query",
            /Duplicate query handlers for "GetUserQuery"/,
        ],
        [
            "message-not-found-context",
            "message class is not imported and not defined in file",
            /Cannot find "NonExistentCommand" - not imported and not defined in/,
        ],
        [
            "invalid-output-module-specifiers-context",
            "output module specifier style is invalid",
            /Invalid outputModuleSpecifiers: "cjs". Expected "js" or "extensionless"./,
        ],
    ])(
        "throws error when %s (%s)",
        async (contextName, _description, expectedError) => {
            const context = makeContext(contextName);
            await expect(context.generate()).rejects.toThrow(expectedError);
        }
    );

    test("generates empty builder when no handlers found", async () => {
        await emptyContext.generate();

        emptyContext.expectOutputFileToContain(
            "export function createApplicationBuilder()",
            "return new ApplicationBuilder();"
        );
        emptyContext.expectOutputFileNotToContain(
            ".withCommandHandler",
            ".withEventHandler"
        );
    });

    test("resolves path aliases from tsconfig.json paths", async () => {
        await pathAliasContext.generate();

        pathAliasContext.expectOutputFileToContain(
            "import { CreateUserHandler } from '../handlers/create-user.handler.js'",
            "import { CreateUserCommand } from '../commands/create-user/request.js'",
            ".withCommandHandler(CreateUserCommand, () => new CreateUserHandler())"
        );
        pathAliasContext.expectOutputFileNotToContain("@app/");
    });

    // Query Handler Tests - verify @QueryHandlerMarker decorator support

    test("generates builder with query handler registration", async () => {
        await queryHandlerContext.generate();

        queryHandlerContext.expectOutputFileToContain(
            "import { GetUserHandler } from '../get-user.handler.js'",
            "import { GetUserQuery } from '../get-user.query.js'",
            ".withQueryHandler(GetUserQuery, () => new GetUserHandler())"
        );
    });

    test("generates builder when command and handler are in the same file", async () => {
        await sameFileContext.generate();

        sameFileContext.expectOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.handler.js'",
            ".withCommandHandler(CreateUserCommand, () => new CreateUserHandler())"
        );
    });

    test("supports extensionless generated imports through programmatic opt-out", async () => {
        await sampleContext.generate({
            outputModuleSpecifiers: "extensionless",
        });

        sampleContext.expectOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler'",
            "import { CreateUserCommand } from '../create-user.command'"
        );
        sampleContext.expectOutputFileNotToContain(
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.command.js'"
        );
    });

    test("generates imports that compile under TypeScript NodeNext", async () => {
        await nodeNextContext.generate();

        nodeNextContext.expectOutputFileToContain(
            "import { ApplicationBuilder } from '../application-builder.js'",
            "import { CreateUserHandler } from '../create-user.handler.js'",
            "import { CreateUserCommand } from '../create-user.command.js'"
        );

        const diagnostics = compileTypeScriptProject(
            path.join(nodeNextContext.path, "tsconfig.json")
        );

        expect(formatDiagnostics(diagnostics)).toBe("");
    });
});

function compileTypeScriptProject(tsconfigPath: string): readonly ts.Diagnostic[] {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (configFile.error) {
        return [configFile.error];
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath)
    );
    const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);

    return [...parsedConfig.errors, ...ts.getPreEmitDiagnostics(program)];
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
    if (diagnostics.length === 0) {
        return "";
    }

    return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => ts.sys.newLine,
    });
}
