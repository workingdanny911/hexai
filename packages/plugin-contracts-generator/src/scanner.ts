import { glob } from "glob";
import ts from "typescript";

import { FileReadError } from "./errors.js";
import { FileSystem, nodeFileSystem } from "./file-system.js";
import type {
    ContractMarkerNames,
    DecoratorNames,
    MessageType,
    TrustedDecoratorSources,
} from "./domain/index.js";
import {
    isMessageContractKind,
    mergeContractMarkerNames,
    mergeDecoratorNames,
} from "./domain/index.js";
import {
    CONTRACT_DECORATOR_SOURCES,
    CONTRACT_DECORATOR_NAMES,
    ContractDecoratorMatcher,
} from "./contract-decorator-matcher.js";

const DEFAULT_EXCLUDE_PATTERNS = [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
];

export interface ScannerOptions {
    exclude?: string[];
    fileSystem?: FileSystem;
    decoratorNames?: DecoratorNames;
    contractMarkerNames?: ContractMarkerNames;
    /**
     * Filter which message types to scan for.
     * Defaults to all types: ['event', 'command', 'query']
     */
    messageTypes?: MessageType[];
    /** Include files marked with comment-based public contract markers. */
    includePublicContracts?: boolean;
    trustedDecoratorSources?: TrustedDecoratorSources;
}

export class Scanner {
    private readonly exclude: string[];
    private readonly fs: FileSystem;
    private readonly markerPatterns: RegExp[];
    private readonly matcher: ContractDecoratorMatcher;
    private readonly trustedDecoratorSources: readonly string[];
    private readonly messageTypes: readonly MessageType[];
    private readonly includePublicContracts: boolean;

    constructor(options: ScannerOptions = {}) {
        this.exclude = options.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
        this.fs = options.fileSystem ?? nodeFileSystem;

        const names = mergeDecoratorNames(options.decoratorNames);
        const messageTypes = options.messageTypes ?? ['event', 'command', 'query'];
        const contractNames = mergeContractMarkerNames(options.contractMarkerNames);

        this.messageTypes = messageTypes;
        this.trustedDecoratorSources = [
            ...CONTRACT_DECORATOR_SOURCES,
            ...(options.trustedDecoratorSources ?? []),
        ];
        this.includePublicContracts =
            options.includePublicContracts ?? options.messageTypes === undefined;
        this.matcher = new ContractDecoratorMatcher({
            decoratorNames: options.decoratorNames,
            contractMarkerName: contractNames.contract,
            trustedDecoratorSources: options.trustedDecoratorSources,
        });

        const decoratorMarkerNames = new Set<string>();
        const commentMarkerNames = new Set<string>();
        for (const type of messageTypes) {
            decoratorMarkerNames.add(names[type]);
        }

        if (this.includePublicContracts) {
            decoratorMarkerNames.add(contractNames.contract);
            commentMarkerNames.add(contractNames.contract);
            commentMarkerNames.add(CONTRACT_DECORATOR_NAMES.generic);
        }

        this.markerPatterns = [
            ...[...decoratorMarkerNames].map(
                (markerName) => new RegExp(
                    `(?:^|[\\r\\n])\\s*@${this.escapeRegex(markerName)}(?![\\w$])`
                )
            ),
            ...[...commentMarkerNames].map(
                (markerName) => new RegExp(
                    `(?:^|[\\r\\n])\\s*(?:(?://)|(?:/\\*\\*?)|\\*)\\s*@${this.escapeRegex(markerName)}(?![\\w$])\\s*\\(`
                )
            ),
        ];
    }

    async scan(sourceDir: string): Promise<string[]> {
        const files = await glob(`${sourceDir}/**/*.ts`, {
            ignore: this.exclude,
        });
        const result: string[] = [];

        for (const file of files) {
            let content: string;
            try {
                content = await this.fs.readFile(file);
            } catch (error) {
                throw new FileReadError(file, { cause: error });
            }

            if (this.containsPublicDecorator(content)) {
                result.push(file);
            }
        }

        return result;
    }

    private containsPublicDecorator(content: string): boolean {
        if (this.markerPatterns.some(pattern => pattern.test(content))) {
            return true;
        }

        if (!this.shouldUseMatcher(content)) {
            return false;
        }

        return this.containsMatcherContract(content);
    }

    private shouldUseMatcher(content: string): boolean {
        return (
            content.includes("@") &&
            this.trustedDecoratorSources.some((source) => content.includes(source))
        );
    }

    private containsMatcherContract(content: string): boolean {
        const sourceFile = ts.createSourceFile(
            "scanner-input.ts",
            content,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS
        );
        const importBindings = this.matcher.buildImportBindingIndex(sourceFile);
        let found = false;

        const visit = (node: ts.Node): void => {
            if (found) return;

            if (ts.isClassDeclaration(node)) {
                const decorators = ts.getDecorators(node);
                if (decorators) {
                    for (const decorator of decorators) {
                        const match = this.matcher.matchDecorator(
                            decorator,
                            importBindings
                        );
                        if (!match) continue;

                        if (
                            isMessageContractKind(match.marker.kind) &&
                            this.messageTypes.includes(match.marker.kind)
                        ) {
                            found = true;
                            return;
                        }

                        if (
                            this.includePublicContracts &&
                            !isMessageContractKind(match.marker.kind)
                        ) {
                            found = true;
                            return;
                        }
                    }
                }
            }

            if (
                this.includePublicContracts &&
                isPublicContractDeclarationNode(node)
            ) {
                const match = this.matcher.matchLeadingCommentMarker(
                    node,
                    sourceFile
                );
                if (match && !isMessageContractKind(match.marker.kind)) {
                    found = true;
                    return;
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return found;
    }

    private escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}

function isPublicContractDeclarationNode(
    node: ts.Node
): node is
    | ts.ClassDeclaration
    | ts.TypeAliasDeclaration
    | ts.InterfaceDeclaration
    | ts.EnumDeclaration {
    return (
        ts.isClassDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isEnumDeclaration(node)
    );
}
