import { execSync } from "child_process";
import { existsSync } from "fs";
import { writeFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { expect } from "vitest";

export interface CompilationResult {
    success: boolean;
    errors: string[];
}

export interface CompileTypeScriptOptions {
    compilerOptions?: Record<string, unknown>;
    packageJson?: Record<string, unknown>;
}

export async function compileTypeScript(
    directory: string,
    options: CompileTypeScriptOptions = {}
): Promise<CompilationResult> {
    const absoluteDir = resolve(directory);

    if (!existsSync(absoluteDir)) {
        return { success: false, errors: [`Directory does not exist: ${absoluteDir}`] };
    }

    const tsconfigPath = join(absoluteDir, "tsconfig.json");
    const packageJsonPath = join(absoluteDir, "package.json");
    const shouldWritePackageJson =
        options.packageJson !== undefined && !existsSync(packageJsonPath);

    const tsconfig = {
        compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            ...options.compilerOptions,
        },
        include: ["./**/*.ts"],
    };

    if (shouldWritePackageJson) {
        await writeFile(
            packageJsonPath,
            JSON.stringify(options.packageJson, null, 2)
        );
    }
    await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2));

    try {
        execSync(`npx tsc --project "${tsconfigPath}"`, {
            encoding: "utf-8",
            stdio: "pipe",
        });

        await rm(tsconfigPath);
        if (shouldWritePackageJson) {
            await rm(packageJsonPath);
        }

        return { success: true, errors: [] };
    } catch (error: unknown) {
        await rm(tsconfigPath).catch(() => {});
        if (shouldWritePackageJson) {
            await rm(packageJsonPath).catch(() => {});
        }

        const execError = error as { stdout?: string; stderr?: string; message?: string };
        const errorOutput = execError.stdout || execError.stderr || execError.message || "Unknown error";
        const errors = errorOutput
            .split("\n")
            .filter((line) => line.trim().length > 0);

        return { success: false, errors };
    }
}

export async function expectTypeScriptCompiles(directory: string): Promise<void> {
    const result = await compileTypeScript(directory);

    if (!result.success) {
        const errorMessage = [
            `TypeScript compilation failed in ${directory}:`,
            ...result.errors.slice(0, 10),
            result.errors.length > 10 ? `... and ${result.errors.length - 10} more errors` : "",
        ]
            .filter(Boolean)
            .join("\n");

        expect.fail(errorMessage);
    }
}

export async function compileTypeScriptWithNodeNext(
    directory: string
): Promise<CompilationResult> {
    return compileTypeScript(directory, {
        compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            baseUrl: process.cwd(),
            paths: {
                "@hexaijs/plugin-contracts-generator/runtime": [
                    "src/runtime/index.ts",
                ],
            },
        },
        packageJson: {
            private: true,
            type: "module",
        },
    });
}

export async function expectTypeScriptCompilesWithNodeNext(
    directory: string
): Promise<void> {
    const result = await compileTypeScriptWithNodeNext(directory);

    if (!result.success) {
        const errorMessage = [
            `TypeScript NodeNext compilation failed in ${directory}:`,
            ...result.errors.slice(0, 10),
            result.errors.length > 10 ? `... and ${result.errors.length - 10} more errors` : "",
        ]
            .filter(Boolean)
            .join("\n");

        expect.fail(errorMessage);
    }
}
