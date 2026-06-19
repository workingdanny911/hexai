import path from "path";

import type { OutputModuleSpecifiers } from "./domain/types.js";

const TYPESCRIPT_EXTENSION_PATTERN = /\.(?:ts|tsx)$/;

export const DEFAULT_OUTPUT_MODULE_SPECIFIERS: OutputModuleSpecifiers = "js";

export function formatRelativeTypeScriptFileSpecifier(
    relativePath: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    return formatRelativeModuleSpecifier(
        ensureRelativeSpecifier(
            normalizeSeparators(relativePath).replace(
                TYPESCRIPT_EXTENSION_PATTERN,
                ""
            )
        ),
        outputModuleSpecifiers
    );
}

export function formatRelativePathFromFile(
    fromRelativeFile: string,
    toRelativeFile: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    const fromDir = path.posix.dirname(normalizeSeparators(fromRelativeFile));
    const toPath = normalizeSeparators(toRelativeFile);
    const relativePath = path.posix.relative(fromDir, toPath);

    return formatRelativeTypeScriptFileSpecifier(
        relativePath,
        outputModuleSpecifiers
    );
}

export function formatRelativeIndexSpecifier(
    relativeDir: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    const normalized = normalizeRelativeDirectory(relativeDir);

    if (outputModuleSpecifiers === "extensionless") {
        return normalized;
    }

    return `${normalized}/index.js`;
}

export function formatRelativeModuleSpecifier(
    moduleSpecifier: string,
    outputModuleSpecifiers: OutputModuleSpecifiers
): string {
    if (outputModuleSpecifiers === "extensionless") {
        return moduleSpecifier;
    }

    return moduleSpecifier.endsWith(".js")
        ? moduleSpecifier
        : `${moduleSpecifier}.js`;
}

function normalizeRelativeDirectory(relativeDir: string): string {
    const normalized = ensureRelativeSpecifier(normalizeSeparators(relativeDir));
    if (normalized === ".") {
        return ".";
    }

    return normalized.replace(/\/$/, "");
}

function ensureRelativeSpecifier(moduleSpecifier: string): string {
    if (
        moduleSpecifier === "." ||
        moduleSpecifier.startsWith("./") ||
        moduleSpecifier.startsWith("../")
    ) {
        return moduleSpecifier;
    }

    return `./${moduleSpecifier}`;
}

function normalizeSeparators(value: string): string {
    return value.replace(/\\/g, "/");
}
