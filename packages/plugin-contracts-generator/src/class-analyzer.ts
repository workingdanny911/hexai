import * as ts from "typescript";

import { isPrimitiveTypeName } from "./ast-utils";

export function hasDecorator(
    node: ts.ClassDeclaration,
    decoratorName: string
): boolean {
    const decorators = ts.getDecorators(node);
    if (!decorators) return false;

    return decorators.some((decorator) => {
        if (ts.isCallExpression(decorator.expression)) {
            const expr = decorator.expression.expression;
            if (ts.isIdentifier(expr)) {
                return expr.text === decoratorName;
            }
        }
        return false;
    });
}

export interface DecoratorOptions {
    response?: string;
    context?: string;
}

/**
 * Extracts options from a decorator call expression.
 * For example, @PublicCommand({ response: 'CreateUserResult' }) returns { response: 'CreateUserResult' }
 */
export function getDecoratorOptions(
    node: ts.ClassDeclaration,
    decoratorName: string
): DecoratorOptions | undefined {
    const decorators = ts.getDecorators(node);
    if (!decorators) return undefined;

    for (const decorator of decorators) {
        if (!ts.isCallExpression(decorator.expression)) continue;

        const expr = decorator.expression.expression;
        if (!ts.isIdentifier(expr) || expr.text !== decoratorName) continue;

        // Found the decorator, now extract options from the first argument
        const args = decorator.expression.arguments;
        if (args.length === 0) return {};

        const firstArg = args[0];
        if (!ts.isObjectLiteralExpression(firstArg)) return {};

        const options: DecoratorOptions = {};

        for (const prop of firstArg.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            if (!ts.isIdentifier(prop.name)) continue;

            const propName = prop.name.text;
            if (propName === "response" && ts.isStringLiteral(prop.initializer)) {
                options.response = prop.initializer.text;
            } else if (propName === "context" && ts.isStringLiteral(prop.initializer)) {
                options.context = prop.initializer.text;
            }
        }

        return options;
    }

    return undefined;
}

export function hasExportModifier(node: ts.Node): boolean {
    const modifiers = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)
        : undefined;
    return (
        modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
    );
}

export function extractClassSourceText(
    node: ts.ClassDeclaration,
    sourceCode: string
): string {
    const fullStart = node.getFullStart();
    const end = node.getEnd();
    let sourceText = sourceCode.slice(fullStart, end);
    sourceText = sourceText.replace(/^\s*\n/, "");
    return sourceText;
}

export function getBaseClassName(node: ts.ClassDeclaration): string | undefined {
    if (!node.heritageClauses) return undefined;

    for (const clause of node.heritageClauses) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            const firstType = clause.types[0];
            if (firstType && ts.isExpressionWithTypeArguments(firstType)) {
                const expr = firstType.expression;
                if (ts.isIdentifier(expr)) {
                    return expr.text;
                }
            }
        }
    }
    return undefined;
}

export function collectClassReferences(node: ts.ClassDeclaration): Set<string> {
    const references = new Set<string>();

    const baseClass = getBaseClassName(node);
    if (baseClass) {
        references.add(baseClass);
    }

    const visitNode = (child: ts.Node): void => {
        if (ts.isTypeReferenceNode(child)) {
            const name = child.typeName.getText();
            if (!isPrimitiveTypeName(name)) {
                references.add(name);
            }
        } else if (ts.isIdentifier(child)) {
            const parent = child.parent;
            if (
                parent &&
                (ts.isTypeReferenceNode(parent) ||
                    ts.isExpressionWithTypeArguments(parent))
            ) {
                const name = child.text;
                if (!isPrimitiveTypeName(name)) {
                    references.add(name);
                }
            }
        }
        ts.forEachChild(child, visitNode);
    };

    ts.forEachChild(node, visitNode);
    return references;
}
