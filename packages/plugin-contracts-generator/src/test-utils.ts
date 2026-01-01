import * as path from "path";

import type {
    SourceFile,
    TypeDefinition,
    DomainEvent,
    Command,
    PrimitiveType,
    ReferenceType,
    Field,
    ClassDefinition,
    ClassImport,
} from "./domain";
import type { FileSystem, FileStats } from "./file-system";

export function createSourceFile(
    path: string = "test.ts",
    absolutePath?: string
): SourceFile {
    return {
        absolutePath: absolutePath ?? `/project/src/${path}`,
        relativePath: path,
    };
}

function isSourceFile(obj: unknown): obj is SourceFile {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "absolutePath" in obj &&
        "relativePath" in obj
    );
}

function isTypeRefBody(obj: unknown): obj is TypeDefinition["body"] {
    return typeof obj === "object" && obj !== null && "kind" in obj;
}

export function createTypeDefinition(
    name: string,
    sourceFileOrBody?: SourceFile | TypeDefinition["body"],
    bodyArg?: TypeDefinition["body"]
): TypeDefinition {
    let sourceFile: SourceFile;
    let body: TypeDefinition["body"];

    if (sourceFileOrBody === undefined) {
        // createTypeDefinition(name)
        sourceFile = createSourceFile(`${name}.ts`);
        body = { kind: "primitive", name: "string" } as PrimitiveType;
    } else if (isSourceFile(sourceFileOrBody)) {
        // createTypeDefinition(name, sourceFile) or createTypeDefinition(name, sourceFile, body)
        sourceFile = sourceFileOrBody;
        body =
            bodyArg ?? ({ kind: "primitive", name: "string" } as PrimitiveType);
    } else if (isTypeRefBody(sourceFileOrBody)) {
        // createTypeDefinition(name, body)
        sourceFile = createSourceFile(`${name}.ts`);
        body = sourceFileOrBody;
    } else {
        // Fallback to defaults
        sourceFile = createSourceFile(`${name}.ts`);
        body = { kind: "primitive", name: "string" } as PrimitiveType;
    }

    return {
        name,
        kind: "type",
        sourceFile,
        body,
        exported: true,
    };
}

export function createEventWithReferenceField(
    eventName: string,
    fieldName: string,
    referencedTypeName: string
): DomainEvent {
    return {
        messageType: "event",
        name: eventName,
        sourceFile: createSourceFile("events.ts"),
        fields: [
            {
                name: fieldName,
                type: {
                    kind: "reference",
                    name: referencedTypeName,
                } as ReferenceType,
                optional: false,
                readonly: true,
            },
        ],
        sourceText: `export class ${eventName} extends Message<{ ${fieldName}: ${referencedTypeName} }> {}`,
        imports: [],
    };
}

export function createCommandWithReferenceField(
    commandName: string,
    fieldName: string,
    referencedTypeName: string
): Command {
    return {
        messageType: "command",
        name: commandName,
        sourceFile: createSourceFile("commands.ts"),
        fields: [
            {
                name: fieldName,
                type: {
                    kind: "reference",
                    name: referencedTypeName,
                } as ReferenceType,
                optional: false,
                readonly: true,
            },
        ],
        sourceText: `export class ${commandName} extends Message<{ ${fieldName}: ${referencedTypeName} }> {}`,
        imports: [],
    };
}

export function createEventWithPrimitiveField(
    eventName: string,
    fieldName: string,
    primitiveName: PrimitiveType["name"]
): DomainEvent {
    return {
        messageType: "event",
        name: eventName,
        sourceFile: createSourceFile("events.ts"),
        fields: [
            {
                name: fieldName,
                type: {
                    kind: "primitive",
                    name: primitiveName,
                } as PrimitiveType,
                optional: false,
                readonly: true,
            },
        ],
        sourceText: `export class ${eventName} extends Message<{ ${fieldName}: ${primitiveName} }> {}`,
        imports: [],
    };
}

export function createField(
    name: string,
    type: Field["type"],
    optional: boolean = false,
    readonly: boolean = false
): Field {
    return {
        name,
        type,
        optional,
        readonly,
    };
}

export interface CreateClassDefinitionOptions {
    sourceFile?: SourceFile;
    baseClass?: string;
    imports?: ClassImport[];
    dependencies?: string[];
    exported?: boolean;
    sourceText?: string;
}

export function createClassDefinition(
    name: string,
    options: CreateClassDefinitionOptions = {}
): ClassDefinition {
    const sourceFile = options.sourceFile ?? createSourceFile(`${name}.ts`);
    const sourceText =
        options.sourceText ?? `export class ${name} { constructor() {} }`;

    return {
        name,
        kind: "class",
        sourceFile,
        sourceText,
        imports: options.imports ?? [],
        dependencies: options.dependencies ?? [],
        baseClass: options.baseClass,
        exported: options.exported ?? true,
    };
}

export interface InMemoryFileSystem extends FileSystem {
    files: Map<string, string>;
    directories: Set<string>;
}

export function createInMemoryFileSystem(): InMemoryFileSystem {
    const files = new Map<string, string>();
    const directories = new Set<string>();

    return {
        files,
        directories,

        async readFile(filePath: string): Promise<string> {
            const content = files.get(filePath);
            if (content === undefined) {
                throw new Error(`File not found: ${filePath}`);
            }
            return content;
        },

        async readdir(dirPath: string): Promise<string[]> {
            const entries: string[] = [];
            const normalizedDir = dirPath.endsWith("/") ? dirPath : dirPath + "/";

            for (const filePath of files.keys()) {
                if (filePath.startsWith(normalizedDir)) {
                    const relativePath = filePath.slice(normalizedDir.length);
                    const firstPart = relativePath.split("/")[0];
                    if (firstPart && !entries.includes(firstPart)) {
                        entries.push(firstPart);
                    }
                }
            }

            for (const dir of directories) {
                if (dir.startsWith(normalizedDir)) {
                    const relativePath = dir.slice(normalizedDir.length);
                    const firstPart = relativePath.split("/")[0];
                    if (firstPart && !entries.includes(firstPart)) {
                        entries.push(firstPart);
                    }
                }
            }

            return entries;
        },

        async writeFile(filePath: string, content: string): Promise<void> {
            files.set(filePath, content);
        },

        async mkdir(dirPath: string, _options?: { recursive?: boolean }): Promise<void> {
            directories.add(dirPath);
        },

        async exists(filePath: string): Promise<boolean> {
            return files.has(filePath) || directories.has(filePath);
        },

        async stat(filePath: string): Promise<FileStats> {
            const isDir = directories.has(filePath);
            const isFile = files.has(filePath);

            if (!isDir && !isFile) {
                throw new Error(`Path not found: ${filePath}`);
            }

            return {
                isDirectory: () => isDir,
                isFile: () => isFile,
            };
        },
    };
}
