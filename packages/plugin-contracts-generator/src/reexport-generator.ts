import * as ts from "typescript";
import * as path from "path";

import { FileSystem, nodeFileSystem } from "./file-system";

/**
 * Represents an import that was rewritten via pathAliasRewrites
 */
export interface RewrittenImport {
    /** The rewritten module specifier (e.g., "@libera/contracts/common/request") */
    readonly rewrittenPath: string;
    /** The original module specifier before rewrite (e.g., "@libera/common/request") */
    readonly originalPath: string;
    /** The imported symbol names */
    readonly symbols: readonly string[];
    /** Whether this is a type-only import */
    readonly isTypeOnly: boolean;
}

/**
 * Represents a re-export file to be generated
 */
export interface ReexportFile {
    /** Relative path within contracts output dir (e.g., "common/request.ts") */
    readonly relativePath: string;
    /** The original module to re-export from */
    readonly originalModule: string;
    /** Symbols to re-export */
    readonly symbols: readonly string[];
    /** Whether all symbols are type-only */
    readonly isTypeOnly: boolean;
}

export interface ReexportGeneratorOptions {
    fileSystem?: FileSystem;
}

export interface AnalyzeOptions {
    /** The files to analyze (absolute paths) */
    readonly files: readonly string[];
    /** Map of original path prefix -> rewritten path prefix */
    readonly pathAliasRewrites: ReadonlyMap<string, string>;
}

export interface GenerateOptions {
    /** The output directory for re-export files */
    readonly outputDir: string;
    /** The re-export files to generate */
    readonly reexportFiles: readonly ReexportFile[];
}

/**
 * Generates re-export files for pathAliasRewrites
 */
export class ReexportGenerator {
    private readonly fs: FileSystem;

    constructor(options: ReexportGeneratorOptions = {}) {
        this.fs = options.fileSystem ?? nodeFileSystem;
    }

    /**
     * Analyzes files to find imports that match pathAliasRewrites
     * and groups them by rewritten path
     */
    async analyze(options: AnalyzeOptions): Promise<ReexportFile[]> {
        const { files, pathAliasRewrites } = options;

        // Invert the map: rewritten prefix -> original prefix
        const rewrittenToOriginal = new Map<string, string>();
        for (const [original, rewritten] of pathAliasRewrites) {
            rewrittenToOriginal.set(rewritten, original);
        }

        // Collect all rewritten imports across all files
        const allImports: RewrittenImport[] = [];

        for (const file of files) {
            const content = await this.fs.readFile(file);
            const imports = this.extractRewrittenImports(content, rewrittenToOriginal);
            allImports.push(...imports);
        }

        // Group by rewritten path and merge symbols
        return this.groupImportsByPath(allImports);
    }

    /**
     * Generates re-export files
     */
    async generate(options: GenerateOptions): Promise<string[]> {
        const { outputDir, reexportFiles } = options;
        const generatedFiles: string[] = [];

        for (const reexport of reexportFiles) {
            const filePath = path.join(outputDir, reexport.relativePath);
            const content = this.generateReexportContent(reexport);

            await this.fs.mkdir(path.dirname(filePath), { recursive: true });
            await this.fs.writeFile(filePath, content);
            generatedFiles.push(filePath);
        }

        return generatedFiles;
    }

    /**
     * Extracts imports from source content that match rewritten prefixes
     */
    private extractRewrittenImports(
        content: string,
        rewrittenToOriginal: ReadonlyMap<string, string>
    ): RewrittenImport[] {
        const sourceFile = ts.createSourceFile(
            "temp.ts",
            content,
            ts.ScriptTarget.Latest,
            true
        );

        const imports: RewrittenImport[] = [];

        ts.forEachChild(sourceFile, (node) => {
            if (!ts.isImportDeclaration(node) || !node.importClause) {
                return;
            }

            const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;

            // Check if this import matches any rewritten prefix
            for (const [rewrittenPrefix, originalPrefix] of rewrittenToOriginal) {
                if (moduleSpecifier.startsWith(rewrittenPrefix)) {
                    const symbols = this.extractSymbolNames(node.importClause);
                    if (symbols.length > 0) {
                        // Calculate the original path
                        const suffix = moduleSpecifier.slice(rewrittenPrefix.length);
                        const originalPath = originalPrefix + suffix;

                        imports.push({
                            rewrittenPath: moduleSpecifier,
                            originalPath,
                            symbols,
                            isTypeOnly: node.importClause.isTypeOnly ?? false,
                        });
                    }
                    break;
                }
            }
        });

        return imports;
    }

    /**
     * Extracts symbol names from import clause
     */
    private extractSymbolNames(importClause: ts.ImportClause): string[] {
        const names: string[] = [];

        // Default import
        if (importClause.name) {
            names.push(importClause.name.text);
        }

        // Named imports
        if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
            for (const element of importClause.namedBindings.elements) {
                // Use the original name if aliased, otherwise use the imported name
                const originalName = element.propertyName?.text ?? element.name.text;
                names.push(originalName);
            }
        }

        return names;
    }

    /**
     * Groups imports by rewritten path and merges symbols
     */
    private groupImportsByPath(imports: RewrittenImport[]): ReexportFile[] {
        const grouped = new Map<string, {
            originalPath: string;
            symbols: Set<string>;
            hasValueImport: boolean;
        }>();

        for (const imp of imports) {
            const existing = grouped.get(imp.rewrittenPath);
            if (existing) {
                for (const symbol of imp.symbols) {
                    existing.symbols.add(symbol);
                }
                if (!imp.isTypeOnly) {
                    existing.hasValueImport = true;
                }
            } else {
                grouped.set(imp.rewrittenPath, {
                    originalPath: imp.originalPath,
                    symbols: new Set(imp.symbols),
                    hasValueImport: !imp.isTypeOnly,
                });
            }
        }

        // Convert to ReexportFile array
        const result: ReexportFile[] = [];
        for (const [rewrittenPath, data] of grouped) {
            // Convert rewritten package path to relative file path
            // e.g., "@libera/contracts/common/request" -> "common/request.ts"
            const relativePath = this.rewrittenPathToRelativePath(rewrittenPath);

            result.push({
                relativePath,
                originalModule: data.originalPath,
                symbols: Array.from(data.symbols).sort(),
                isTypeOnly: !data.hasValueImport,
            });
        }

        return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }

    /**
     * Converts a rewritten package path to a relative file path
     * e.g., "@libera/contracts/common/request" with prefix "@libera/contracts"
     *       -> "common/request.ts"
     */
    private rewrittenPathToRelativePath(rewrittenPath: string): string {
        // Find the subpath after the package name
        // Assume format: @scope/package/subpath or package/subpath
        const parts = rewrittenPath.split("/");

        let subpathStart: number;
        if (parts[0].startsWith("@")) {
            // Scoped package: @scope/package/subpath
            subpathStart = 2;
        } else {
            // Regular package: package/subpath
            subpathStart = 1;
        }

        const subpath = parts.slice(subpathStart).join("/");

        // If no subpath, use index.ts
        if (!subpath) {
            return "index.ts";
        }

        return subpath + ".ts";
    }

    /**
     * Generates the content for a re-export file
     */
    private generateReexportContent(reexport: ReexportFile): string {
        const exportKeyword = reexport.isTypeOnly ? "export type" : "export";
        const symbols = reexport.symbols.join(", ");
        return `${exportKeyword} { ${symbols} } from "${reexport.originalModule}";\n`;
    }
}
