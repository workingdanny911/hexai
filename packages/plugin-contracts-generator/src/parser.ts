import ts from "typescript";

import type {
    ClassImport,
    Command,
    ContractMarkerNames,
    DecoratorNames,
    DomainEvent,
    Field,
    IntersectionType,
    Message,
    MessageType,
    ObjectType,
    PublicContract,
    PublicContractDeclarationKind,
    Query,
    ResponseNamingConvention,
    SourceFile,
    TypeDefinition,
    TypeDefinitionKind,
    TypeRef,
} from "./domain/index.js";
import { mergeContractMarkerNames, mergeDecoratorNames } from "./domain/index.js";
import { extractFieldsFromMembers, parseTypeNode } from "./ast-utils.js";
import {
    extractClassSourceText,
    getBaseClassName,
    getDecoratorOptions,
    hasDecorator,
    hasExportModifier,
    hasLeadingCommentMarker,
} from "./class-analyzer.js";
import { extractImports } from "./import-analyzer.js";

export type { MessageType };

const PAYLOAD_TYPE_ARGUMENT_INDEX = 0;

export interface ParseResult {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly publicContracts: readonly PublicContract[];
    readonly typeDefinitions: readonly TypeDefinition[];
}

export interface ParserOptions {
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    messageTypes?: readonly MessageType[];
    includePublicContracts?: boolean;
}

interface ExtractedPayload {
    fields: Field[];
    payloadType?: TypeRef;
}

interface ExtractedMessage extends ExtractedPayload {
    sourceText: string;
    imports: ClassImport[];
    baseClass?: string;
}

interface DecoratorMapping {
    decorator: string;
    messageType: MessageType;
}

function buildDecoratorMappings(decoratorNames: Required<DecoratorNames>): DecoratorMapping[] {
    return [
        { decorator: decoratorNames.event, messageType: "event" },
        { decorator: decoratorNames.command, messageType: "command" },
        { decorator: decoratorNames.query, messageType: "query" },
    ];
}


function extractTypeParameterNames(
    typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined
): string[] | undefined {
    if (!typeParameters) return undefined;
    return typeParameters.map(tp => tp.name.text);
}

export class Parser {
    private readonly decoratorMappings: DecoratorMapping[];
    private readonly contractMarkerName: string;
    private readonly responseNamingConventions: readonly ResponseNamingConvention[];
    private readonly messageTypes: readonly MessageType[] | undefined;
    private readonly includePublicContracts: boolean;

    constructor(options: ParserOptions = {}) {
        const names = mergeDecoratorNames(options.decoratorNames);
        const contractNames = mergeContractMarkerNames(options.contractMarkerNames);
        this.decoratorMappings = buildDecoratorMappings(names);
        this.contractMarkerName = contractNames.contract;
        this.responseNamingConventions = options.responseNamingConventions ?? [];
        this.messageTypes = options.messageTypes;
        this.includePublicContracts =
            options.includePublicContracts ?? options.messageTypes === undefined;
    }

    parse(sourceCode: string, sourceFileInfo: SourceFile): ParseResult {
        const tsSourceFile = ts.createSourceFile(
            sourceFileInfo.absolutePath,
            sourceCode,
            ts.ScriptTarget.Latest,
            true
        );

        const events: DomainEvent[] = [];
        const commands: Command[] = [];
        const queries: Query[] = [];
        const publicContracts: PublicContract[] = [];
        const typeDefinitions: TypeDefinition[] = [];

        const messageCollectors: Record<MessageType, (message: Message) => void> = {
            event: (m) => events.push(m as DomainEvent),
            command: (m) => commands.push(m as Command),
            query: (m) => queries.push(m as Query),
        };

        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                this.collectMessagesFromClass(node, sourceCode, tsSourceFile, sourceFileInfo, messageCollectors);
                this.collectPublicContract(
                    node,
                    "class",
                    sourceCode,
                    sourceFileInfo,
                    publicContracts
                );
            }

            if (ts.isTypeAliasDeclaration(node) && node.name) {
                typeDefinitions.push(this.extractTypeDefinition(node, sourceFileInfo));
                this.collectPublicContract(
                    node,
                    "type",
                    sourceCode,
                    sourceFileInfo,
                    publicContracts
                );
            }

            if (ts.isInterfaceDeclaration(node) && node.name) {
                typeDefinitions.push(this.extractInterfaceDefinition(node, sourceFileInfo));
                this.collectPublicContract(
                    node,
                    "interface",
                    sourceCode,
                    sourceFileInfo,
                    publicContracts
                );
            }

            if (ts.isEnumDeclaration(node) && node.name) {
                this.collectPublicContract(
                    node,
                    "enum",
                    sourceCode,
                    sourceFileInfo,
                    publicContracts
                );
            }

            ts.forEachChild(node, visit);
        };

        visit(tsSourceFile);

        this.applyNamingConventionMatching(commands, typeDefinitions);
        this.applyNamingConventionMatching(queries, typeDefinitions);

        return {
            events,
            commands,
            queries,
            publicContracts,
            typeDefinitions,
        };
    }

    private collectPublicContract(
        node:
            | ts.ClassDeclaration
            | ts.TypeAliasDeclaration
            | ts.InterfaceDeclaration
            | ts.EnumDeclaration,
        declarationKind: PublicContractDeclarationKind,
        sourceCode: string,
        sourceFileInfo: SourceFile,
        publicContracts: PublicContract[]
    ): void {
        if (!this.includePublicContracts) return;
        if (!node.name) return;
        if (!hasLeadingCommentMarker(node, sourceCode, this.contractMarkerName)) {
            return;
        }

        publicContracts.push({
            name: node.name.text,
            contractType: "contract",
            declarationKind,
            sourceFile: sourceFileInfo,
            exported: hasExportModifier(node),
        });
    }

    private collectMessagesFromClass(
        node: ts.ClassDeclaration,
        sourceCode: string,
        tsSourceFile: ts.SourceFile,
        sourceFileInfo: SourceFile,
        collectors: Record<MessageType, (message: Message) => void>
    ): void {
        for (const { decorator, messageType } of this.decoratorMappings) {
            if (!hasDecorator(node, decorator)) continue;
            if (this.messageTypes && !this.messageTypes.includes(messageType)) continue;

            const message = this.buildMessage(node, sourceCode, tsSourceFile, sourceFileInfo, messageType, decorator);
            collectors[messageType](message);
        }
    }

    private applyNamingConventionMatching(
        messages: (Command | Query)[],
        typeDefinitions: TypeDefinition[]
    ): void {
        for (const message of messages) {
            const hasExplicitResultType = Boolean(message.resultType);
            if (hasExplicitResultType) continue;

            const matchedTypeName = this.findMatchingResponseType(message.name, typeDefinitions);
            if (matchedTypeName) {
                (message as { resultType?: TypeRef }).resultType = {
                    kind: "reference",
                    name: matchedTypeName,
                };
            }
        }
    }

    private findMatchingResponseType(
        messageName: string,
        typeDefinitions: TypeDefinition[]
    ): string | undefined {
        for (const convention of this.responseNamingConventions) {
            const hasSuffix = messageName.endsWith(convention.messageSuffix);
            if (!hasSuffix) continue;

            const messagePrefix = messageName.slice(0, -convention.messageSuffix.length);
            const expectedResponseName = messagePrefix + convention.responseSuffix;

            const matchingType = typeDefinitions.find(t => t.name === expectedResponseName);
            if (matchingType) return matchingType.name;
        }
        return undefined;
    }

    private buildMessage(
        node: ts.ClassDeclaration,
        sourceCode: string,
        tsSourceFile: ts.SourceFile,
        sourceFileInfo: SourceFile,
        messageType: MessageType,
        decoratorName: string
    ): Message {
        const extracted = this.extractMessageDetails(node, sourceCode, tsSourceFile);
        const decoratorOptions = getDecoratorOptions(node, decoratorName);

        const baseMessage = {
            name: node.name!.text,
            messageType,
            sourceFile: sourceFileInfo,
            fields: extracted.fields,
            payloadType: extracted.payloadType,
            sourceText: extracted.sourceText,
            imports: extracted.imports,
            baseClass: extracted.baseClass,
        };

        const explicitResponseName = decoratorOptions?.response;
        const supportsResultType = messageType === "command" || messageType === "query";
        if (!supportsResultType || !explicitResponseName) {
            return baseMessage;
        }

        return {
            ...baseMessage,
            resultType: {
                kind: "reference" as const,
                name: explicitResponseName,
            },
        };
    }

    private extractMessageDetails(
        node: ts.ClassDeclaration,
        sourceCode: string,
        tsSourceFile: ts.SourceFile
    ): ExtractedMessage {
        const { fields, payloadType } = this.extractPayload(node);
        const sourceText = extractClassSourceText(node, sourceCode);
        const imports = extractImports(tsSourceFile);
        const baseClass = getBaseClassName(node);

        return {
            fields,
            payloadType,
            sourceText,
            imports,
            baseClass,
        };
    }

    private extractPayload(node: ts.ClassDeclaration): ExtractedPayload {
        const emptyPayload: ExtractedPayload = { fields: [] };
        if (!node.heritageClauses) return emptyPayload;

        const extendsClause = node.heritageClauses.find(
            clause => clause.token === ts.SyntaxKind.ExtendsKeyword
        );
        if (!extendsClause) return emptyPayload;

        for (const type of extendsClause.types) {
            const typeArgs = type.typeArguments;
            if (!typeArgs || typeArgs.length === 0) continue;

            const payloadTypeArg = typeArgs[PAYLOAD_TYPE_ARGUMENT_INDEX];
            const extractedPayload = this.parsePayloadTypeArgument(payloadTypeArg);
            if (extractedPayload) return extractedPayload;
        }

        return emptyPayload;
    }

    private parsePayloadTypeArgument(typeArg: ts.TypeNode): ExtractedPayload | undefined {
        if (ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)) {
            return {
                fields: [],
                payloadType: parseTypeNode(typeArg),
            };
        }

        if (ts.isTypeLiteralNode(typeArg)) {
            return {
                fields: extractFieldsFromMembers(typeArg.members),
            };
        }

        if (ts.isIntersectionTypeNode(typeArg)) {
            const parsedType = parseTypeNode(typeArg) as IntersectionType;
            return {
                fields: this.flattenIntersectionToFields(parsedType),
                payloadType: parsedType,
            };
        }

        return undefined;
    }

    private flattenIntersectionToFields(intersection: IntersectionType): Field[] {
        const fields: Field[] = [];

        for (const type of intersection.types) {
            if (type.kind === "object") {
                fields.push(...(type as ObjectType).fields);
            }
        }

        return fields;
    }

    private extractTypeDefinition(
        node: ts.TypeAliasDeclaration,
        sourceFileInfo: SourceFile
    ): TypeDefinition {
        return this.buildTypeDefinition(
            node.name.text,
            "type",
            sourceFileInfo,
            parseTypeNode(node.type),
            node.typeParameters,
            node
        );
    }

    private extractInterfaceDefinition(
        node: ts.InterfaceDeclaration,
        sourceFileInfo: SourceFile
    ): TypeDefinition {
        const body: ObjectType = {
            kind: "object",
            fields: extractFieldsFromMembers(node.members),
        };

        return this.buildTypeDefinition(
            node.name.text,
            "interface",
            sourceFileInfo,
            body,
            node.typeParameters,
            node
        );
    }

    private buildTypeDefinition(
        name: string,
        kind: TypeDefinitionKind,
        sourceFile: SourceFile,
        body: TypeRef,
        typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
        node: ts.Node
    ): TypeDefinition {
        return {
            name,
            kind,
            sourceFile,
            body,
            typeParameters: extractTypeParameterNames(typeParameters),
            exported: hasExportModifier(node),
        };
    }
}
