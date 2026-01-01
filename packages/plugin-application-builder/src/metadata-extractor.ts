import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
    HandlerMetadata,
    CommandHandlerMetadata,
    EventHandlerMetadata,
    QueryHandlerMetadata,
} from "./types";
import { MessageClassNotFoundError } from "./errors";

/**
 * Extracts handler metadata from TypeScript files using AST parsing
 */
export class HandlerMetadataExtractor {
    private config: {
        commandHandlerDecorator: string;
        eventHandlerDecorator: string;
    } = {
        commandHandlerDecorator: "CommandHandlerMarker",
        eventHandlerDecorator: "EventHandlerMarker",
    };

    constructor(
        private contextPath: string,
        private outputFile: string,
        config: {
            commandHandlerDecorator?: string;
            eventHandlerDecorator?: string;
        } = {}
    ) {
        if (config.commandHandlerDecorator) {
            this.config.commandHandlerDecorator =
                config.commandHandlerDecorator;
        }
        if (config.eventHandlerDecorator) {
            this.config.eventHandlerDecorator = config.eventHandlerDecorator;
        }
    }

    extractHandlersMetadata(files: string[]): HandlerMetadata[] {
        const handlers: HandlerMetadata[] = [];

        for (const file of files) {
            const sourceCode = fs.readFileSync(file, "utf-8");
            const sourceFile = ts.createSourceFile(
                file,
                sourceCode,
                ts.ScriptTarget.Latest,
                true
            );

            ts.forEachChild(sourceFile, (node) => {
                if (ts.isClassDeclaration(node)) {
                    const metadata = this.extractFromClass(
                        node,
                        file,
                        sourceFile
                    );
                    if (metadata) {
                        handlers.push(metadata);
                    }
                }
            });
        }

        return handlers;
    }

    private extractFromClass(
        classNode: ts.ClassDeclaration,
        filePath: string,
        sourceFile: ts.SourceFile
    ): HandlerMetadata | null {
        const className = classNode.name?.text;
        if (!className) return null;

        // Get decorators using TypeScript 5.0+ API
        const decorators = ts.canHaveDecorators(classNode)
            ? ts.getDecorators(classNode)
            : undefined;
        if (!decorators) return null;

        for (const decorator of decorators) {
            const expression = decorator.expression;
            if (!ts.isCallExpression(expression)) continue;

            const decoratorName = expression.expression.getText();

            if (decoratorName === "CommandHandlerMarker") {
                return this.extractCommandHandlerMetadata(
                    className,
                    expression,
                    filePath,
                    sourceFile
                );
            }

            if (decoratorName === "EventHandlerMarker") {
                return this.extractEventHandlerMetadata(
                    className,
                    expression,
                    filePath
                );
            }

            if (decoratorName === "QueryHandlerMarker") {
                return this.extractQueryHandlerMetadata(
                    className,
                    expression,
                    filePath,
                    sourceFile
                );
            }
        }

        return null;
    }

    private extractMessageHandlerMetadata(
        className: string,
        expression: ts.CallExpression,
        filePath: string,
        sourceFile: ts.SourceFile
    ): { messagePath: string; messageClassName: string } {
        const messageClassArg = expression.arguments[0];
        const messageClassName = messageClassArg!.getText();
        const messageImport = this.findImportForSymbol(
            messageClassName,
            sourceFile
        );

        let messagePath = "";
        let resolvedMessageClassName = messageClassName;

        if (messageImport) {
            const handlerDir = path.dirname(filePath);
            const resolvedImportPath = this.resolvePathAlias(messageImport.path);
            const messageAbsolutePath = path.resolve(
                handlerDir,
                resolvedImportPath + ".ts"
            );
            messagePath = this.toRelativeImport(messageAbsolutePath);
            resolvedMessageClassName = messageImport.symbol;
        } else if (this.isClassDefinedInFile(messageClassName, sourceFile)) {
            messagePath = this.toRelativeImport(filePath);
        } else {
            throw new MessageClassNotFoundError(messageClassName, filePath);
        }

        return {
            messagePath,
            messageClassName: resolvedMessageClassName,
        };
    }

    private isClassDefinedInFile(
        className: string,
        sourceFile: ts.SourceFile
    ): boolean {
        for (const statement of sourceFile.statements) {
            if (
                ts.isClassDeclaration(statement) &&
                statement.name?.text === className
            ) {
                return true;
            }
        }
        return false;
    }

    private extractCommandHandlerMetadata(
        className: string,
        expression: ts.CallExpression,
        filePath: string,
        sourceFile: ts.SourceFile
    ): CommandHandlerMetadata {
        const { messagePath, messageClassName } = this.extractMessageHandlerMetadata(
            className,
            expression,
            filePath,
            sourceFile
        );

        return {
            type: "command",
            handlerPath: this.toRelativeImport(filePath),
            handlerClassName: className,
            commandPath: messagePath,
            commandClassName: messageClassName,
        };
    }

    private extractEventHandlerMetadata(
        className: string,
        expression: ts.CallExpression,
        filePath: string
    ): EventHandlerMetadata {
        let options = {};
        if (expression.arguments.length > 0) {
            const optionsArg = expression.arguments[0];
            options = this.parseObjectLiteral(optionsArg);
        }

        return {
            type: "event",
            handlerPath: this.toRelativeImport(filePath),
            handlerClassName: className,
            eventHandlerOptions: options,
        };
    }

    private extractQueryHandlerMetadata(
        className: string,
        expression: ts.CallExpression,
        filePath: string,
        sourceFile: ts.SourceFile
    ): QueryHandlerMetadata {
        const { messagePath, messageClassName } = this.extractMessageHandlerMetadata(
            className,
            expression,
            filePath,
            sourceFile
        );

        return {
            type: "query",
            handlerPath: this.toRelativeImport(filePath),
            handlerClassName: className,
            queryPath: messagePath,
            queryClassName: messageClassName,
        };
    }

    private findImportForSymbol(
        symbol: string,
        sourceFile: ts.SourceFile
    ): { path: string; symbol: string } | null {
        for (const statement of sourceFile.statements) {
            if (ts.isImportDeclaration(statement)) {
                const importClause = statement.importClause;
                const moduleSpecifier = (
                    statement.moduleSpecifier as ts.StringLiteral
                ).text;

                if (
                    importClause?.namedBindings &&
                    ts.isNamedImports(importClause.namedBindings)
                ) {
                    for (const element of importClause.namedBindings.elements) {
                        if (element.name.text === symbol) {
                            return {
                                path: moduleSpecifier,
                                symbol: element.name.text,
                            };
                        }
                    }
                }
            }
        }

        return null;
    }

    private toRelativeImport(absolutePath: string): string {
        const outputFileAbsolutePath = path.join(
            this.contextPath,
            this.outputFile
        );
        const outputDir = path.dirname(outputFileAbsolutePath);

        const relative = path.relative(outputDir, absolutePath);
        const withoutExtension = relative.replace(/\.ts$/, "");
        // Ensure relative path has proper prefix
        return withoutExtension.startsWith(".")
            ? withoutExtension
            : "./" + withoutExtension;
    }

    private parseObjectLiteral(node: ts.Node): Record<string, any> {
        if (!ts.isObjectLiteralExpression(node)) {
            return {};
        }

        const result: Record<string, any> = {};

        for (const property of node.properties) {
            if (ts.isPropertyAssignment(property)) {
                const name = property.name.getText();
                const value = property.initializer;

                if (ts.isStringLiteral(value)) {
                    result[name] = value.text;
                } else if (ts.isNumericLiteral(value)) {
                    result[name] = Number(value.text);
                } else if (value.kind === ts.SyntaxKind.TrueKeyword) {
                    result[name] = true;
                } else if (value.kind === ts.SyntaxKind.FalseKeyword) {
                    result[name] = false;
                }
            }
        }

        return result;
    }

    private resolvePathAlias(importPath: string): string {
        const tsconfigPath = path.join(this.contextPath, "tsconfig.json");
        if (!fs.existsSync(tsconfigPath)) return importPath;

        const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
        const paths = tsconfig.compilerOptions?.paths;
        const baseUrl = tsconfig.compilerOptions?.baseUrl || ".";

        if (!paths) return importPath;

        for (const [alias, targets] of Object.entries(paths)) {
            const aliasPrefix = alias.replace("/*", "");
            if (importPath.startsWith(aliasPrefix)) {
                const targetBase = (targets as string[])[0].replace("/*", "");
                const resolvedBase = path.join(this.contextPath, baseUrl, targetBase);
                return importPath.replace(aliasPrefix, resolvedBase);
            }
        }

        return importPath;
    }
}
