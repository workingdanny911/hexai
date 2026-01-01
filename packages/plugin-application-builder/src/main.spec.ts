import { describe, expect, test } from "vitest";
import { ApplicationBuilder } from "@hexaijs/application";
import { makeContext, useContext } from "./test";

describe.sequential("Build Plugin - Application Builder Generation", () => {
    const sampleContext = useContext("sample-context");
    const orderContext = useContext("order-context");
    const emptyContext = useContext("empty-context");
    const pathAliasContext = useContext("path-alias-context");
    const queryHandlerContext = useContext("query-handler-context");
    const sameFileContext = useContext("same-file-context");

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
                `import { ${handlerClass} } from '../${handlerFile}'`,
                `import { ${commandClass} } from '../${commandFile}'`,
                `.withCommandHandler(${commandClass}, () => new ${handlerClass}())`
            );
        }
    );

    test("generates builder with event handler registration", async () => {
        await sampleContext.generate();

        sampleContext.expectOutputFileToContain(
            "import { UserCreatedEventHandler } from '../user-created.handler'",
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
            "import { CreateOrderHandler } from '../create-order.handler'",
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
            "import { CreateUserHandler } from '../handlers/create-user.handler'",
            "import { CreateUserCommand } from '../commands/create-user/request'",
            ".withCommandHandler(CreateUserCommand, () => new CreateUserHandler())"
        );
        pathAliasContext.expectOutputFileNotToContain("@/");
    });

    // Query Handler Tests - verify @QueryHandlerMarker decorator support

    test("generates builder with query handler registration", async () => {
        await queryHandlerContext.generate();

        queryHandlerContext.expectOutputFileToContain(
            "import { GetUserHandler } from '../get-user.handler'",
            "import { GetUserQuery } from '../get-user.query'",
            ".withQueryHandler(GetUserQuery, () => new GetUserHandler())"
        );
    });

    test("generates builder when command and handler are in the same file", async () => {
        await sameFileContext.generate();

        sameFileContext.expectOutputFileToContain(
            "import { CreateUserHandler } from '../create-user.handler'",
            "import { CreateUserCommand } from '../create-user.handler'",
            ".withCommandHandler(CreateUserCommand, () => new CreateUserHandler())"
        );
    });
});
