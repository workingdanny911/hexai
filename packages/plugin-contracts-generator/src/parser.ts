import ts from "typescript";

import type {
    ClassImport,
    Command,
    ContractDeclaration,
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
    TrustedDecoratorSources,
} from "./domain/index.js";
import {
    isMessageContractKind,
    mergeContractMarkerNames,
    toMessageType,
} from "./domain/index.js";
import { extractFieldsFromMembers, parseTypeNode } from "./ast-utils.js";
import {
    extractClassSourceText,
    getBaseClassName,
    hasExportModifier,
} from "./class-analyzer.js";
import { ContractDecoratorMatcher } from "./contract-decorator-matcher.js";
import { extractImports } from "./import-analyzer.js";
import type { ImportBinding } from "./import-analyzer.js";

export type { MessageType };

const PAYLOAD_TYPE_ARGUMENT_INDEX = 0;

export interface ParseResult {
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries: readonly Query[];
    readonly publicContracts: readonly PublicContract[];
    readonly contractDeclarations: readonly ContractDeclaration[];
    readonly typeDefinitions: readonly TypeDefinition[];
}

export interface ParserOptions {
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    responseNamingConventions?: readonly ResponseNamingConvention[];
    messageTypes?: readonly MessageType[];
    includePublicContracts?: boolean;
    trustedDecoratorSources?: TrustedDecoratorSources;
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

function extractTypeParameterNames(
    typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined
): string[] | undefined {
    if (!typeParameters) return undefined;
    return typeParameters.map(tp => tp.name.text);
}

function getStringOption(
    options: Readonly<Record<string, unknown>> | undefined,
    name: string
): string | undefined {
    const value = options?.[name];
    return typeof value === "string" ? value : undefined;
}

function getNumberOption(
    options: Readonly<Record<string, unknown>> | undefined,
    name: string
): number | undefined {
    const value = options?.[name];
    return typeof value === "number" ? value : undefined;
}

export class Parser {
    private readonly matcher: ContractDecoratorMatcher;
    private readonly responseNamingConventions: readonly ResponseNamingConvention[];
    private readonly messageTypes: readonly MessageType[] | undefined;
    private readonly includePublicContracts: boolean;

    constructor(options: ParserOptions = {}) {
        const contractNames = mergeContractMarkerNames(options.contractMarkerNames);
        this.matcher = new ContractDecoratorMatcher({
            decoratorNames: options.decoratorNames,
            contractMarkerName: contractNames.contract,
            trustedDecoratorSources: options.trustedDecoratorSources,
        });
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
        const contractDeclarations: ContractDeclaration[] = [];
        const typeDefinitions: TypeDefinition[] = [];
        const importBindings = this.matcher.buildImportBindingIndex(tsSourceFile);

        const messageCollectors: Record<MessageType, (message: Message) => void> = {
            event: (m) => events.push(m as DomainEvent),
            command: (m) => commands.push(m as Command),
            query: (m) => queries.push(m as Query),
        };

        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.name) {
                this.collectMessagesFromClass(
                    node,
                    sourceCode,
                    tsSourceFile,
                    sourceFileInfo,
                    importBindings,
                    messageCollectors,
                    contractDeclarations
                );
                this.collectPublicContract(
                    node,
                    "class",
                    tsSourceFile,
                    sourceFileInfo,
                    importBindings,
                    publicContracts,
                    contractDeclarations
                );
            }

            if (ts.isTypeAliasDeclaration(node) && node.name) {
                typeDefinitions.push(this.extractTypeDefinition(node, sourceFileInfo));
                this.collectPublicContract(
                    node,
                    "type",
                    tsSourceFile,
                    sourceFileInfo,
                    importBindings,
                    publicContracts,
                    contractDeclarations
                );
            }

            if (ts.isInterfaceDeclaration(node) && node.name) {
                typeDefinitions.push(this.extractInterfaceDefinition(node, sourceFileInfo));
                this.collectPublicContract(
                    node,
                    "interface",
                    tsSourceFile,
                    sourceFileInfo,
                    importBindings,
                    publicContracts,
                    contractDeclarations
                );
            }

            if (ts.isEnumDeclaration(node) && node.name) {
                this.collectPublicContract(
                    node,
                    "enum",
                    tsSourceFile,
                    sourceFileInfo,
                    importBindings,
                    publicContracts,
                    contractDeclarations
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
            contractDeclarations,
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
        tsSourceFile: ts.SourceFile,
        sourceFileInfo: SourceFile,
        importBindings: ReadonlyMap<string, ImportBinding>,
        publicContracts: PublicContract[],
        contractDeclarations: ContractDeclaration[]
    ): void {
        if (!this.includePublicContracts) return;
        if (!node.name) return;

        const decoratorMatch =
            declarationKind === "class"
                ? this.findGeneralContractDecorator(
                    node as ts.ClassDeclaration,
                    importBindings
                )
                : undefined;
        const commentMatch = this.matcher.matchLeadingCommentMarker(
            node,
            tsSourceFile
        );
        const marker = decoratorMatch?.marker ?? commentMatch?.marker;

        if (!marker || isMessageContractKind(marker.kind)) {
            return;
        }

        const declaration = {
            name: node.name.text,
            contractType: "contract",
            kind: marker.kind ?? "contract",
            visibility: marker.visibility,
            tags: marker.tags,
            marker,
            declarationKind,
            sourceFile: sourceFileInfo,
            exported: hasExportModifier(node),
        } satisfies ContractDeclaration & PublicContract;

        publicContracts.push(declaration);
        contractDeclarations.push(declaration);
    }

    private collectMessagesFromClass(
        node: ts.ClassDeclaration,
        sourceCode: string,
        tsSourceFile: ts.SourceFile,
        sourceFileInfo: SourceFile,
        importBindings: ReadonlyMap<string, ImportBinding>,
        collectors: Record<MessageType, (message: Message) => void>,
        contractDeclarations: ContractDeclaration[]
    ): void {
        const decorators = ts.getDecorators(node);
        if (!decorators) return;

        for (const decorator of decorators) {
            const match = this.matcher.matchDecorator(decorator, importBindings);
            if (!match) continue;

            const messageType = toMessageType(match.marker.kind);
            if (!messageType) continue;
            if (this.messageTypes && !this.messageTypes.includes(messageType)) continue;

            const message = this.buildMessage(
                node,
                sourceCode,
                tsSourceFile,
                sourceFileInfo,
                messageType,
                match.marker
            );
            const declaration = {
                ...message,
                contractType: "message",
                kind: messageType,
                visibility: match.marker.visibility,
                tags: match.marker.tags,
                marker: match.marker,
            } as ContractDeclaration & Message;

            collectors[messageType](declaration);
            contractDeclarations.push(declaration);
        }
    }

    private findGeneralContractDecorator(
        node: ts.ClassDeclaration,
        importBindings: ReadonlyMap<string, ImportBinding>
    ) {
        const decorators = ts.getDecorators(node);
        if (!decorators) return undefined;

        for (const decorator of decorators) {
            const match = this.matcher.matchDecorator(decorator, importBindings);
            if (!match) continue;
            if (!isMessageContractKind(match.marker.kind)) return match;
        }

        return undefined;
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
        marker: ContractDeclaration["marker"]
    ): Message {
        const extracted = this.extractMessageDetails(node, sourceCode, tsSourceFile);
        const explicitContext = getStringOption(marker.options, "context");
        const explicitVersion = getNumberOption(marker.options, "version");

        const baseMessage = {
            name: node.name!.text,
            messageType,
            sourceFile: sourceFileInfo,
            fields: extracted.fields,
            payloadType: extracted.payloadType,
            sourceText: extracted.sourceText,
            imports: extracted.imports,
            baseClass: extracted.baseClass,
            kind: messageType,
            visibility: marker.visibility,
            tags: marker.tags,
            marker,
            context: explicitContext,
            ...(messageType === "event" && explicitVersion !== undefined
                ? { version: explicitVersion }
                : {}),
        } as Message;

        const explicitResponseName = getStringOption(marker.options, "response");
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
        } as Message;
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
