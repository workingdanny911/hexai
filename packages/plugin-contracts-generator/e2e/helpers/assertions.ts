import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { expect } from "vitest";
import type { ProcessContextResult } from "@/index";

export function expectFileExists(filePath: string, message?: string): void {
    expect(
        existsSync(filePath),
        message ?? `File should exist: ${filePath}`
    ).toBe(true);
}

export function expectFileNotExists(filePath: string, message?: string): void {
    expect(
        existsSync(filePath),
        message ?? `File should not exist: ${filePath}`
    ).toBe(false);
}

export async function expectFileContains(
    filePath: string,
    patterns: string | string[]
): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    const patternList = Array.isArray(patterns) ? patterns : [patterns];

    for (const pattern of patternList) {
        expect(
            content,
            `File ${filePath} should contain "${pattern}"`
        ).toContain(pattern);
    }
}

export async function expectFileNotContains(
    filePath: string,
    patterns: string | string[]
): Promise<void> {
    const content = await readFile(filePath, "utf-8");
    const patternList = Array.isArray(patterns) ? patterns : [patterns];

    for (const pattern of patternList) {
        expect(
            content,
            `File ${filePath} should not contain "${pattern}"`
        ).not.toContain(pattern);
    }
}

export function expectGeneratedFiles(
    outputDir: string,
    contextName: string,
    expectedFiles: string[]
): void {
    const contextDir = join(outputDir, contextName);

    for (const file of expectedFiles) {
        const filePath = join(contextDir, file);
        expectFileExists(
            filePath,
            `Expected file ${file} to exist in ${contextName}/`
        );
    }
}

export function expectExtractionResult(
    result: ProcessContextResult,
    expected: {
        eventCount?: number;
        commandCount?: number;
        copiedFileCount?: number;
    }
): void {
    if (expected.eventCount !== undefined) {
        expect(result.events).toHaveLength(expected.eventCount);
    }
    if (expected.commandCount !== undefined) {
        expect(result.commands).toHaveLength(expected.commandCount);
    }
    if (expected.copiedFileCount !== undefined) {
        expect(result.copiedFiles).toHaveLength(expected.copiedFileCount);
    }
}

export function expectEvent(
    result: ProcessContextResult,
    eventName: string
): void {
    const eventNames = result.events.map((e) => e.name);
    expect(
        eventNames,
        `Expected event "${eventName}" to be extracted`
    ).toContain(eventName);
}

export function expectCommand(
    result: ProcessContextResult,
    commandName: string
): void {
    const commandNames = result.commands.map((c) => c.name);
    expect(
        commandNames,
        `Expected command "${commandName}" to be extracted`
    ).toContain(commandName);
}

export function expectEvents(
    result: ProcessContextResult,
    eventNames: string[]
): void {
    for (const name of eventNames) {
        expectEvent(result, name);
    }
}

export function expectCommands(
    result: ProcessContextResult,
    commandNames: string[]
): void {
    for (const name of commandNames) {
        expectCommand(result, name);
    }
}
