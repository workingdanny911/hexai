import * as ts from "typescript";

import type {
    TypeRef,
    PrimitiveType,
    ReferenceType,
    ArrayType,
    ObjectType,
    UnionType,
    IntersectionType,
    Field,
} from "./domain";

const PRIMITIVE_TYPE_NAMES = new Set([
    "string",
    "number",
    "boolean",
    "void",
    "null",
    "undefined",
    "any",
    "unknown",
    "never",
    "bigint",
    "symbol",
]);

export function isPrimitiveTypeName(name: string): boolean {
    return PRIMITIVE_TYPE_NAMES.has(name);
}

export function parseTypeNode(typeNode: ts.TypeNode): TypeRef {
    if (typeNode.kind === ts.SyntaxKind.StringKeyword) {
        return { kind: "primitive", name: "string" } as PrimitiveType;
    }
    if (typeNode.kind === ts.SyntaxKind.NumberKeyword) {
        return { kind: "primitive", name: "number" } as PrimitiveType;
    }
    if (typeNode.kind === ts.SyntaxKind.BooleanKeyword) {
        return { kind: "primitive", name: "boolean" } as PrimitiveType;
    }

    if (ts.isArrayTypeNode(typeNode)) {
        const elementType = parseTypeNode(typeNode.elementType);
        return { kind: "array", elementType } as ArrayType;
    }

    if (ts.isTypeReferenceNode(typeNode)) {
        const name = typeNode.typeName.getText();
        const typeArguments = typeNode.typeArguments
            ? typeNode.typeArguments.map((t) => parseTypeNode(t))
            : undefined;
        return { kind: "reference", name, typeArguments } as ReferenceType;
    }

    if (ts.isIntersectionTypeNode(typeNode)) {
        const types = typeNode.types.map((t) => parseTypeNode(t));
        return { kind: "intersection", types } as IntersectionType;
    }

    if (ts.isUnionTypeNode(typeNode)) {
        const types = typeNode.types.map((t) => parseTypeNode(t));
        return { kind: "union", types } as UnionType;
    }

    if (ts.isTypeLiteralNode(typeNode)) {
        const fields = extractFieldsFromMembers(typeNode.members);
        return { kind: "object", fields } as ObjectType;
    }

    return { kind: "reference", name: typeNode.getText() } as ReferenceType;
}

export function extractFieldsFromMembers(
    members: ts.NodeArray<ts.TypeElement>
): Field[] {
    const fields: Field[] = [];
    for (const member of members) {
        if (ts.isPropertySignature(member) && member.name) {
            const fieldName = member.name.getText();
            const fieldType = member.type
                ? parseTypeNode(member.type)
                : ({ kind: "primitive", name: "any" } as PrimitiveType);
            const optional = !!member.questionToken;
            const readonly =
                member.modifiers?.some(
                    (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword
                ) ?? false;
            fields.push({
                name: fieldName,
                type: fieldType,
                optional,
                readonly,
            });
        }
    }
    return fields;
}
