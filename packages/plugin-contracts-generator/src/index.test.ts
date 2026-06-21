import { describe, expect, it } from "vitest";

import {
    Contract,
    ContractCommand,
    ContractEvent,
    ContractQuery,
    ConfigurationError,
    PublicContract,
    processContext,
    type ContractCommandOptions,
    type ContractDeclaration,
    type ContractEventOptions,
    type ContractOptions,
    type ContractQueryOptions,
    type DecoratorNames,
    type MessageType,
} from "./index.js";

describe("plugin package decorator exports", () => {
    it("should re-export Contract decorators from the contracts package surface", () => {
        class ContractMessage {}

        expect(Contract()(ContractMessage)).toBe(ContractMessage);
        expect(ContractEvent()(ContractMessage)).toBe(ContractMessage);
        expect(ContractCommand()(ContractMessage)).toBe(ContractMessage);
        expect(ContractQuery()(ContractMessage)).toBe(ContractMessage);
        expect(PublicContract({ kind: "snapshot" })(ContractMessage)).toBe(
            ContractMessage
        );
    });

    it("should re-export Contract option types", () => {
        const genericOptions = {
            kind: "query",
            response: "UserProfile",
        } satisfies ContractOptions;
        const eventOptions = { version: 2 } satisfies ContractEventOptions;
        const commandOptions = {
            response: "CreateUserResult",
        } satisfies ContractCommandOptions;
        const queryOptions = { response: "UserProfile" } satisfies ContractQueryOptions;

        expect(genericOptions.response).toBe("UserProfile");
        expect(eventOptions.version).toBe(2);
        expect(commandOptions.response).toBe("CreateUserResult");
        expect(queryOptions.response).toBe("UserProfile");
    });

    it("should re-export documented domain types", () => {
        type GeneralDeclaration = Extract<
            ContractDeclaration,
            { contractType: "contract" }
        >;

        const messageType = "command" satisfies MessageType;
        const decoratorNames = {
            command: "ContractCommand",
        } satisfies DecoratorNames;
        const declaration = {
            name: "UserProfile",
            contractType: "contract",
            kind: "contract",
            visibility: "public",
            tags: [],
            marker: {
                syntax: "comment",
                name: "PublicContract",
                canonicalName: "PublicContract",
                kind: "contract",
                visibility: "public",
                tags: [],
                legacy: false,
            },
            sourceFile: {
                absolutePath: "/workspace/src/user-profile.ts",
                relativePath: "src/user-profile.ts",
            },
            exported: true,
            declarationKind: "interface",
        } satisfies GeneralDeclaration;

        expect(messageType).toBe("command");
        expect(decoratorNames.command).toBe("ContractCommand");
        expect(declaration.declarationKind).toBe("interface");
    });

    it("should reject removed entryStrategy in processContext options", async () => {
        await expect(
            processContext({
                contextName: "orders",
                path: "/tmp/orders",
                outputDir: "/tmp/contracts",
                entryStrategy: "graph",
            } as unknown as Parameters<typeof processContext>[0])
        ).rejects.toThrow(ConfigurationError);

        await expect(
            processContext({
                contextName: "orders",
                path: "/tmp/orders",
                outputDir: "/tmp/contracts",
                entryStrategy: "graph",
            } as unknown as Parameters<typeof processContext>[0])
        ).rejects.toThrow("entryStrategy has been removed");
    });
});
