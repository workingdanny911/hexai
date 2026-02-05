import { execSync } from "child_process";
import { existsSync } from "fs";
import { writeFile, rm } from "fs/promises";
import { join, resolve } from "path";
import { expect } from "vitest";

export interface CompilationResult {
    success: boolean;
    errors: string[];
}

export async function compileTypeScript(directory: string): Promise<CompilationResult> {
    const absoluteDir = resolve(directory);

    if (!existsSync(absoluteDir)) {
        return { success: false, errors: [`Directory does not exist: ${absoluteDir}`] };
    }

    const tsconfigPath = join(absoluteDir, "tsconfig.json");

    const tsconfig = {
        compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
        },
        include: ["./**/*.ts"],
    };

    await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2));

    try {
        execSync(`npx tsc --project "${tsconfigPath}"`, {
            encoding: "utf-8",
            stdio: "pipe",
        });

        await rm(tsconfigPath);

        return { success: true, errors: [] };
    } catch (error: unknown) {
        await rm(tsconfigPath).catch(() => {});

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
