import path from "node:path";

import type { OutputModuleSpecifiers } from "./config.js";

const TYPESCRIPT_EXTENSION_PATTERN = /\.(?:ts|tsx|mts|cts)$/;
const JAVASCRIPT_EXTENSION_PATTERN = /\.(?:js|jsx|mjs|cjs)$/;
const TYPESCRIPT_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
    return (
        moduleSpecifier === "." ||
        moduleSpecifier.startsWith("./") ||
        moduleSpecifier.startsWith("../")
    );
}

export function formatRelativeTypeScriptFileSpecifier(
    relativePath: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    return formatRelativeModuleSpecifier(
        normalizeSeparators(relativePath).replace(
            TYPESCRIPT_EXTENSION_PATTERN,
            ""
        ),
        outputModuleSpecifiers
    );
}

export function formatRelativePathFromFile(
    fromFilePath: string,
    toFilePath: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    const fromDir = path.posix.dirname(normalizeSeparators(fromFilePath));
    const toPath = normalizeSeparators(toFilePath);
    const relativePath = path.posix.relative(fromDir, toPath);

    return formatRelativeTypeScriptFileSpecifier(
        relativePath,
        outputModuleSpecifiers
    );
}

export function formatRelativeModuleSpecifier(
    moduleSpecifier: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    const normalized = ensureRelativeSpecifier(
        normalizeSeparators(moduleSpecifier)
            .replace(TYPESCRIPT_EXTENSION_PATTERN, "")
            .replace(JAVASCRIPT_EXTENSION_PATTERN, "")
    );

    if (outputModuleSpecifiers === "extensionless") {
        return normalized;
    }

    return `${normalized}.js`;
}

export function normalizeSourceImportToTypeScriptPath(
    importPath: string
): string {
    const normalized = normalizeSeparators(importPath);
    const extension = path.posix.extname(normalized);

    if (TYPESCRIPT_SOURCE_EXTENSIONS.has(extension)) {
        return normalized;
    }

    if (extension === ".js") {
        return replaceExtension(normalized, ".ts");
    }

    if (extension === ".jsx") {
        return replaceExtension(normalized, ".tsx");
    }

    if (extension === ".mjs") {
        return replaceExtension(normalized, ".mts");
    }

    if (extension === ".cjs") {
        return replaceExtension(normalized, ".cts");
    }

    if (extension === "") {
        return `${normalized}.ts`;
    }

    return normalized;
}

export function getTypeScriptSourceFileCandidates(
    importPath: string
): string[] {
    const normalized = normalizeSeparators(importPath);
    const extension = path.posix.extname(normalized);

    if (TYPESCRIPT_SOURCE_EXTENSIONS.has(extension)) {
        return [normalized];
    }

    if (extension === ".js") {
        return unique([
            replaceExtension(normalized, ".ts"),
            replaceExtension(normalized, ".tsx"),
        ]);
    }

    if (extension === ".jsx") {
        return [replaceExtension(normalized, ".tsx")];
    }

    if (extension === ".mjs") {
        return [replaceExtension(normalized, ".mts")];
    }

    if (extension === ".cjs") {
        return [replaceExtension(normalized, ".cts")];
    }

    if (extension === "") {
        return unique([
            `${normalized}.ts`,
            `${normalized}.tsx`,
            `${normalized}/index.ts`,
            `${normalized}/index.tsx`,
        ]);
    }

    return [normalized];
}

function ensureRelativeSpecifier(moduleSpecifier: string): string {
    if (isRelativeModuleSpecifier(moduleSpecifier)) {
        return moduleSpecifier;
    }

    return `./${moduleSpecifier}`;
}

function normalizeSeparators(value: string): string {
    return value.replace(/\\/g, "/");
}

function replaceExtension(filePath: string, extension: string): string {
    return filePath.slice(0, -path.posix.extname(filePath).length) + extension;
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}
