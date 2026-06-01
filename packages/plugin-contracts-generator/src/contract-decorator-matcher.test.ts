import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { ContractDecoratorMatcher } from "./contract-decorator-matcher.js";

function createSourceFile(sourceCode: string): ts.SourceFile {
    return ts.createSourceFile(
        "contracts.ts",
        sourceCode,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
}

function getFirstClassDecorator(sourceFile: ts.SourceFile): ts.Decorator {
    const classDeclaration = sourceFile.statements.find(ts.isClassDeclaration);
    if (!classDeclaration) throw new Error("Expected class declaration");

    const decorators = ts.getDecorators(classDeclaration);
    if (!decorators?.[0]) throw new Error("Expected decorator");

    return decorators[0];
}

describe("ContractDecoratorMatcher", () => {
    it("should match a direct named ContractCommand import", () => {
        const sourceFile = createSourceFile(`
            import { ContractCommand } from "@hexaijs/contracts/decorators";

            @ContractCommand({ visibility: "internal", tags: ["admin"] })
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match?.marker).toMatchObject({
            syntax: "decorator",
            name: "ContractCommand",
            canonicalName: "ContractCommand",
            kind: "command",
            visibility: "internal",
            tags: ["admin"],
            legacy: false,
            importedName: "ContractCommand",
            localName: "ContractCommand",
            moduleSpecifier: "@hexaijs/contracts/decorators",
        });
    });

    it("should match named alias imports and generic Contract kind options", () => {
        const sourceFile = createSourceFile(`
            import { Contract as InternalContract } from "@hexaijs/contracts";

            @InternalContract({ kind: "query" })
            export class FindUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match?.marker).toMatchObject({
            name: "InternalContract",
            canonicalName: "Contract",
            kind: "query",
            visibility: "public",
            legacy: false,
            importedName: "Contract",
            localName: "InternalContract",
            moduleSpecifier: "@hexaijs/contracts",
        });
    });

    it("should support configured trusted decorator sources", () => {
        const sourceFile = createSourceFile(`
            import { ContractEvent as EventMarker } from "@app/contracts";

            @EventMarker()
            export class UserCreated {}
        `);
        const matcher = new ContractDecoratorMatcher({
            trustedDecoratorSources: ["@app/contracts"],
        });

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match?.marker).toMatchObject({
            name: "EventMarker",
            canonicalName: "ContractEvent",
            kind: "event",
            moduleSpecifier: "@app/contracts",
        });
    });

    it("should ignore same-named imports from untrusted sources", () => {
        const sourceFile = createSourceFile(`
            import { ContractCommand } from "other-contracts";

            @ContractCommand()
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match).toBeUndefined();
    });

    it("should ignore unbound canonical Contract decorators by default", () => {
        const sourceFile = createSourceFile(`
            @ContractCommand()
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match).toBeUndefined();
    });

    it("should keep legacy Public decorators compatible when imported from local barrels", () => {
        const sourceFile = createSourceFile(`
            import { PublicCommand } from "@/decorators";

            @PublicCommand()
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match?.marker).toMatchObject({
            name: "PublicCommand",
            canonicalName: "ContractCommand",
            kind: "command",
            legacy: true,
            moduleSpecifier: "@/decorators",
        });
    });

    it("should ignore type-only decorator imports", () => {
        const sourceFile = createSourceFile(`
            import type { ContractCommand } from "@hexaijs/contracts";

            @ContractCommand()
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match).toBeUndefined();
    });

    it("should ignore namespace decorator imports because they are unsupported", () => {
        const sourceFile = createSourceFile(`
            import * as Contracts from "@hexaijs/contracts";

            @Contracts.ContractCommand()
            export class CreateUser {}
        `);
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match).toBeUndefined();
    });

    it("should preserve decoratorNames replacement semantics for legacy names", () => {
        const sourceFile = createSourceFile(`
            @PublicEvent()
            export class UserCreated {}
        `);
        const matcher = new ContractDecoratorMatcher({
            decoratorNames: {
                event: "ExternalEvent",
            },
        });

        const match = matcher.matchDecorator(
            getFirstClassDecorator(sourceFile),
            sourceFile
        );

        expect(match).toBeUndefined();
    });

    it("should extract declaration-leading comment marker options", () => {
        const sourceFile = createSourceFile(`
            // @PublicContract({ kind: "snapshot", visibility: "internal", tags: ["read"] })
            export interface UserSnapshot {}
        `);
        const interfaceDeclaration = sourceFile.statements.find(
            ts.isInterfaceDeclaration
        );
        if (!interfaceDeclaration) throw new Error("Expected interface declaration");
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchLeadingCommentMarker(
            interfaceDeclaration,
            sourceFile
        );

        expect(match?.marker).toMatchObject({
            syntax: "comment",
            name: "PublicContract",
            canonicalName: "Contract",
            kind: "snapshot",
            visibility: "internal",
            tags: ["read"],
            legacy: true,
        });
    });

    it("should ignore prose that mentions a marker-shaped Contract call", () => {
        const sourceFile = createSourceFile(`
            /**
             * This paragraph mentions @Contract({ kind: "snapshot" }) as prose.
             */
            export interface UserSnapshot {}
        `);
        const interfaceDeclaration = sourceFile.statements.find(
            ts.isInterfaceDeclaration
        );
        if (!interfaceDeclaration) throw new Error("Expected interface declaration");
        const matcher = new ContractDecoratorMatcher();

        const match = matcher.matchLeadingCommentMarker(
            interfaceDeclaration,
            sourceFile
        );

        expect(match).toBeUndefined();
    });
});
