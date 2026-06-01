import * as ts from "typescript";

import type {
    ContractKind,
    ContractMarkerMetadata,
    ContractVisibility,
    DecoratorNames,
    MessageContractKind,
} from "./domain/index.js";
import { mergeDecoratorNames } from "./domain/index.js";
import type { ImportBinding } from "./import-analyzer.js";
import { extractImportBindings } from "./import-analyzer.js";

export const CONTRACT_DECORATOR_SOURCES = [
    "@hexaijs/contracts",
    "@hexaijs/contracts/decorators",
];

export const CONTRACT_DECORATOR_NAMES = {
    generic: "Contract",
    command: "ContractCommand",
    query: "ContractQuery",
    event: "ContractEvent",
} as const;

export const LEGACY_CONTRACT_DECORATOR_NAMES = {
    generic: "PublicContract",
    command: "PublicCommand",
    query: "PublicQuery",
    event: "PublicEvent",
} as const;

export interface ContractDecoratorMatcherOptions {
    readonly trustedDecoratorSources?: readonly string[];
    readonly decoratorNames?: DecoratorNames;
    readonly contractMarkerName?: string;
    readonly allowUnboundDecorators?: boolean;
}

export interface ContractDecoratorMatch {
    readonly marker: ContractMarkerMetadata;
    readonly decorator: ts.Decorator;
    readonly expression: ts.Expression;
    readonly callExpression?: ts.CallExpression;
    readonly binding?: ImportBinding;
}

export interface ContractCommentMarkerMatch {
    readonly marker: ContractMarkerMetadata;
    readonly range: ts.CommentRange;
    readonly text: string;
}

interface DecoratorDefinition {
    readonly name: string;
    readonly canonicalName: string;
    readonly kind?: MessageContractKind | "contract";
    readonly legacy: boolean;
    readonly allowUnbound: boolean;
}

type ParsedMarkerOptions = Readonly<Record<string, unknown>>;

const DEFAULT_VISIBILITY: ContractVisibility = "public";

export class ContractDecoratorMatcher {
    private readonly trustedDecoratorSources: ReadonlySet<string>;
    private readonly definitionsByImportedName: ReadonlyMap<string, DecoratorDefinition>;
    private readonly allowUnboundDecorators: boolean;

    constructor(options: ContractDecoratorMatcherOptions = {}) {
        this.trustedDecoratorSources = new Set([
            ...CONTRACT_DECORATOR_SOURCES,
            ...(options.trustedDecoratorSources ?? []),
        ]);
        this.definitionsByImportedName = buildDecoratorDefinitions(options);
        this.allowUnboundDecorators = options.allowUnboundDecorators ?? false;
    }

    buildImportBindingIndex(
        sourceFile: ts.SourceFile
    ): ReadonlyMap<string, ImportBinding> {
        const bindings = new Map<string, ImportBinding>();

        for (const binding of extractImportBindings(sourceFile)) {
            bindings.set(binding.localName, binding);
        }

        return bindings;
    }

    matchDecorator(
        decorator: ts.Decorator,
        bindingsOrSourceFile: ReadonlyMap<string, ImportBinding> | ts.SourceFile
    ): ContractDecoratorMatch | undefined {
        const bindingIndex = isImportBindingIndex(bindingsOrSourceFile)
            ? bindingsOrSourceFile
            : this.buildImportBindingIndex(bindingsOrSourceFile);
        const expression = unwrapDecoratorExpression(decorator.expression);
        const localName = getIdentifierName(expression);

        if (!localName) return undefined;

        const callExpression = ts.isCallExpression(decorator.expression)
            ? decorator.expression
            : undefined;
        const binding = bindingIndex.get(localName);
        const definition = this.resolveDefinition(localName, binding);

        if (!definition) return undefined;

        const options = extractOptionsFromCall(callExpression);
        const kind = resolveKind(definition, options);
        const marker = buildMarkerMetadata({
            syntax: "decorator",
            name: localName,
            canonicalName: definition.canonicalName,
            kind,
            legacy: definition.legacy,
            options,
            binding,
        });

        return {
            marker,
            decorator,
            expression,
            callExpression,
            binding,
        };
    }

    matchLeadingCommentMarker(
        node: ts.Node,
        sourceFile: ts.SourceFile
    ): ContractCommentMarkerMatch | undefined {
        const sourceText = sourceFile.getFullText();
        const ranges =
            ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];

        for (const range of ranges) {
            const text = sourceText.slice(range.pos, range.end);
            const match = this.matchCommentText(text, range);
            if (match) return match;
        }

        return undefined;
    }

    matchCommentText(
        text: string,
        range: ts.CommentRange = { pos: 0, end: text.length, kind: ts.SyntaxKind.SingleLineCommentTrivia }
    ): ContractCommentMarkerMatch | undefined {
        for (const definition of this.definitionsByImportedName.values()) {
            const marker = extractCommentMarker(text, definition.name);
            if (!marker) continue;

            const options = parseOptionsExpression(marker.optionsText);
            const kind = resolveKind(definition, options);

            return {
                marker: buildMarkerMetadata({
                    syntax: "comment",
                    name: definition.name,
                    canonicalName: definition.canonicalName,
                    kind,
                    legacy: definition.legacy,
                    options,
                }),
                range,
                text,
            };
        }

        return undefined;
    }

    private resolveDefinition(
        localName: string,
        binding: ImportBinding | undefined
    ): DecoratorDefinition | undefined {
        if (!binding) {
            const definition = this.definitionsByImportedName.get(localName);
            if (!definition) return undefined;
            if (
                definition.legacy ||
                definition.allowUnbound ||
                this.allowUnboundDecorators
            ) {
                return definition;
            }
            return undefined;
        }

        if (
            binding.importKind !== "named" ||
            binding.isTypeOnly ||
            !this.trustedDecoratorSources.has(binding.moduleSpecifier)
        ) {
            const localDefinition = this.definitionsByImportedName.get(localName);
            return localDefinition?.legacy ? localDefinition : undefined;
        }

        return this.definitionsByImportedName.get(binding.importedName);
    }
}

function buildDecoratorDefinitions(
    options: ContractDecoratorMatcherOptions
): ReadonlyMap<string, DecoratorDefinition> {
    const definitions = new Map<string, DecoratorDefinition>();
    const legacyDecoratorNames = mergeDecoratorNames(options.decoratorNames);
    const customUnboundNames = new Set(
        [
            ...Object.values(options.decoratorNames ?? {}),
            options.contractMarkerName,
        ].filter((name): name is string => typeof name === "string")
    );

    addDefinition(definitions, CONTRACT_DECORATOR_NAMES.generic, "Contract", "contract", false, customUnboundNames.has(CONTRACT_DECORATOR_NAMES.generic));
    addDefinition(definitions, CONTRACT_DECORATOR_NAMES.command, "ContractCommand", "command", false, customUnboundNames.has(CONTRACT_DECORATOR_NAMES.command));
    addDefinition(definitions, CONTRACT_DECORATOR_NAMES.query, "ContractQuery", "query", false, customUnboundNames.has(CONTRACT_DECORATOR_NAMES.query));
    addDefinition(definitions, CONTRACT_DECORATOR_NAMES.event, "ContractEvent", "event", false, customUnboundNames.has(CONTRACT_DECORATOR_NAMES.event));

    addDefinition(definitions, legacyDecoratorNames.command, "ContractCommand", "command", true);
    addDefinition(definitions, legacyDecoratorNames.query, "ContractQuery", "query", true);
    addDefinition(definitions, legacyDecoratorNames.event, "ContractEvent", "event", true);

    if (options.contractMarkerName) {
        addDefinition(definitions, options.contractMarkerName, "Contract", "contract", true);
    } else {
        addDefinition(definitions, LEGACY_CONTRACT_DECORATOR_NAMES.generic, "Contract", "contract", true);
    }

    return definitions;
}

function addDefinition(
    definitions: Map<string, DecoratorDefinition>,
    name: string,
    canonicalName: string,
    kind: MessageContractKind | "contract",
    legacy: boolean,
    allowUnbound = legacy
): void {
    const existing = definitions.get(name);
    if (existing) {
        definitions.set(name, {
            ...existing,
            legacy: existing.legacy || legacy,
            allowUnbound: existing.allowUnbound || allowUnbound,
        });
        return;
    }
    definitions.set(name, { name, canonicalName, kind, legacy, allowUnbound });
}

function isImportBindingIndex(
    value: ReadonlyMap<string, ImportBinding> | ts.SourceFile
): value is ReadonlyMap<string, ImportBinding> {
    return typeof (value as ReadonlyMap<string, ImportBinding>).get === "function";
}

function unwrapDecoratorExpression(expression: ts.Expression): ts.Expression {
    if (ts.isCallExpression(expression)) return expression.expression;
    return expression;
}

function getIdentifierName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    return undefined;
}

function extractOptionsFromCall(
    callExpression: ts.CallExpression | undefined
): ParsedMarkerOptions | undefined {
    const firstArgument = callExpression?.arguments[0];
    if (!firstArgument || !ts.isObjectLiteralExpression(firstArgument)) {
        return undefined;
    }

    return parseObjectLiteral(firstArgument);
}

function parseOptionsExpression(
    optionsText: string | undefined
): ParsedMarkerOptions | undefined {
    if (!optionsText?.trim()) return undefined;

    const sourceFile = ts.createSourceFile(
        "contract-marker-options.ts",
        `const markerOptions = ${optionsText};`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    const statement = sourceFile.statements[0];

    if (
        !statement ||
        !ts.isVariableStatement(statement) ||
        !statement.declarationList.declarations[0]?.initializer ||
        !ts.isObjectLiteralExpression(statement.declarationList.declarations[0].initializer)
    ) {
        return undefined;
    }

    return parseObjectLiteral(statement.declarationList.declarations[0].initializer);
}

function parseObjectLiteral(
    objectLiteral: ts.ObjectLiteralExpression
): ParsedMarkerOptions {
    const result: Record<string, unknown> = {};

    for (const property of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(property)) continue;

        const name = getPropertyName(property.name);
        if (!name) continue;

        result[name] = parseLiteralValue(property.initializer);
    }

    return result;
}

function getPropertyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    return undefined;
}

function parseLiteralValue(expression: ts.Expression): unknown {
    if (ts.isStringLiteral(expression)) return expression.text;
    if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isNumericLiteral(expression)) return Number(expression.text);
    if (ts.isArrayLiteralExpression(expression)) {
        return expression.elements.map((element) => parseLiteralValue(element));
    }

    return undefined;
}

function resolveKind(
    definition: DecoratorDefinition,
    options: ParsedMarkerOptions | undefined
): ContractKind {
    if (definition.canonicalName === CONTRACT_DECORATOR_NAMES.generic) {
        const optionKind = options?.kind;
        if (typeof optionKind === "string") return optionKind;
    }

    return definition.kind ?? "contract";
}

function buildMarkerMetadata(input: {
    readonly syntax: "decorator" | "comment";
    readonly name: string;
    readonly canonicalName: string;
    readonly kind: ContractKind;
    readonly legacy: boolean;
    readonly options?: ParsedMarkerOptions;
    readonly binding?: ImportBinding;
}): ContractMarkerMetadata {
    return {
        syntax: input.syntax,
        name: input.name,
        canonicalName: input.canonicalName,
        kind: input.kind,
        visibility: extractVisibility(input.options),
        tags: extractTags(input.options),
        legacy: input.legacy,
        options: input.options,
        importedName: input.binding?.importedName,
        localName: input.binding?.localName,
        moduleSpecifier: input.binding?.moduleSpecifier,
    };
}

function extractVisibility(
    options: ParsedMarkerOptions | undefined
): ContractVisibility {
    return options?.visibility === "internal" ? "internal" : DEFAULT_VISIBILITY;
}

function extractTags(options: ParsedMarkerOptions | undefined): readonly string[] {
    const tags = options?.tags;
    if (!Array.isArray(tags)) return [];

    return tags.filter((tag): tag is string => typeof tag === "string");
}

function extractCommentMarker(
    text: string,
    markerName: string
): { readonly optionsText?: string } | undefined {
    const escapedName = escapeRegExp(markerName);
    const pattern = new RegExp(`^@${escapedName}\\b\\s*\\((.*)\\)\\s*$`);

    for (const line of getNormalizedCommentLines(text)) {
        const match = pattern.exec(line);
        if (match) return { optionsText: match[1] };
    }

    return undefined;
}

function getNormalizedCommentLines(text: string): string[] {
    return text.split(/\r?\n/).map((line) => {
        let trimmed = line.trim();

        if (trimmed.startsWith("//")) {
            return trimmed.slice(2).trim();
        }

        if (trimmed.startsWith("/**")) {
            trimmed = trimmed.slice(3).trim();
        } else if (trimmed.startsWith("/*")) {
            trimmed = trimmed.slice(2).trim();
        }

        if (trimmed.endsWith("*/")) {
            trimmed = trimmed.slice(0, -2).trim();
        }

        if (trimmed.startsWith("*")) {
            trimmed = trimmed.slice(1).trim();
        }

        return trimmed;
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
