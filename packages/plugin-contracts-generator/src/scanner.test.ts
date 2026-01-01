import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Scanner } from "./scanner";
import type { DecoratorNames, MessageType } from "./domain";

describe("Scanner", () => {
    it("should find files containing @PublicEvent or @PublicCommand decorator", async () => {
        const scanner = new Scanner();
        const files = await scanner.scan("test/fixtures/sample-project");

        expect(files.some((f) => f.includes("event-file.ts"))).toBe(true);
        expect(files.some((f) => f.includes("command-file.ts"))).toBe(true);
        expect(files.some((f) => f.includes("no-decorator.ts"))).toBe(false);
    });

    it("should exclude node_modules, dist, .d.ts, .test.ts, and .spec.ts files", async () => {
        const scanner = new Scanner();
        const files = await scanner.scan("test/fixtures/sample-project");

        expect(files.some((f) => f.includes("node_modules"))).toBe(false);
        expect(files.some((f) => f.includes("/dist/"))).toBe(false);
        expect(files.some((f) => f.endsWith(".d.ts"))).toBe(false);
        expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
        expect(files.some((f) => f.endsWith(".spec.ts"))).toBe(false);
    });

    it("should accept custom exclude patterns via options", async () => {
        const scanner = new Scanner({
            exclude: [
                "**/node_modules/**",
                "**/dist/**",
                "**/*.d.ts",
                "**/command-file.ts",
            ],
        });
        const files = await scanner.scan("test/fixtures/sample-project");

        expect(files.some((f) => f.includes("command-file.ts"))).toBe(false);
        expect(files.some((f) => f.includes("event-file.ts"))).toBe(true);
    });

    describe("custom decorator patterns", () => {
        // Tests for configurable decorator names in scanner
        // When decoratorNames is provided, the scanner should look for those
        // decorators instead of the default @PublicEvent, @PublicCommand, @PublicQuery

        let tempDir: string;

        beforeEach(async () => {
            tempDir = await mkdtemp(join(tmpdir(), "scanner-test-"));
        });

        afterEach(async () => {
            await rm(tempDir, { recursive: true, force: true });
        });

        it("should scan for custom decorator when decoratorNames is provided", async () => {
            // Arrange: Create a temp file with @ContractEvent() decorator
            const fileContent = `
import { Message } from "@hexaijs/core";

@ContractEvent()
export class OrderPlaced extends Message<{
    orderId: string;
}> {}
`;
            const filePath = join(tempDir, "order-events.ts");
            await writeFile(filePath, fileContent);

            // Act: Scanner with custom decoratorNames should find the file
            const customDecoratorNames: DecoratorNames = {
                event: "ContractEvent",
                command: "ContractCommand",
                query: "ContractQuery",
            };
            const scannerWithCustomDecorators = new Scanner({
                decoratorNames: customDecoratorNames,
            });
            const filesWithCustomDecorators =
                await scannerWithCustomDecorators.scan(tempDir);

            // Assert: Custom decorator scanner should find the file
            expect(filesWithCustomDecorators).toHaveLength(1);
            expect(filesWithCustomDecorators[0]).toContain("order-events.ts");

            // Act: Scanner with default decoratorNames should NOT find the file
            const scannerWithDefaults = new Scanner();
            const filesWithDefaults = await scannerWithDefaults.scan(tempDir);

            // Assert: Default decorator scanner should not find the file
            expect(filesWithDefaults).toHaveLength(0);
        });

        it("should scan for partial custom decorators with defaults for unspecified", async () => {
            // Arrange: Create files with mixed decorators
            const customEventFile = `
@CustomEvent()
export class EventA extends Message<{ id: string }> {}
`;
            const defaultCommandFile = `
@PublicCommand()
export class CommandB extends Request<{ id: string }> {}
`;
            await writeFile(join(tempDir, "custom-event.ts"), customEventFile);
            await writeFile(
                join(tempDir, "default-command.ts"),
                defaultCommandFile
            );

            // Act: Scanner with partial decoratorNames (only event customized)
            const partialDecoratorNames: Partial<DecoratorNames> = {
                event: "CustomEvent",
            };
            const scanner = new Scanner({
                decoratorNames: partialDecoratorNames,
            });
            const files = await scanner.scan(tempDir);

            // Assert: Should find both files - custom event and default command
            expect(files).toHaveLength(2);
            expect(files.some((f) => f.includes("custom-event.ts"))).toBe(true);
            expect(files.some((f) => f.includes("default-command.ts"))).toBe(
                true
            );
        });
    });

    describe("messageTypes filtering", () => {
        // Tests for filtering which message types to scan for
        // When messageTypes is provided, the scanner should only look for those decorators

        it("should scan only for event decorators when messageTypes is ['event']", async () => {
            const scanner = new Scanner({
                messageTypes: ["event"],
            });
            const files = await scanner.scan("test/fixtures/sample-project");

            // Should find event file but not command file
            expect(files.some((f) => f.includes("event-file.ts"))).toBe(true);
            expect(files.some((f) => f.includes("command-file.ts"))).toBe(
                false
            );
        });

        it("should scan only for command decorators when messageTypes is ['command']", async () => {
            const scanner = new Scanner({
                messageTypes: ["command"],
            });
            const files = await scanner.scan("test/fixtures/sample-project");

            // Should find command file but not event file
            expect(files.some((f) => f.includes("command-file.ts"))).toBe(true);
            expect(files.some((f) => f.includes("event-file.ts"))).toBe(false);
        });

        it("should scan for multiple types when messageTypes is ['command', 'query']", async () => {
            const scanner = new Scanner({
                messageTypes: ["command", "query"],
            });
            const files = await scanner.scan("test/fixtures/sample-project");

            // Should find command file, but not event file (only command and query requested)
            expect(files.some((f) => f.includes("command-file.ts"))).toBe(true);
            expect(files.some((f) => f.includes("event-file.ts"))).toBe(false);
        });

        it("should scan all types when messageTypes is not provided (default)", async () => {
            const scanner = new Scanner();
            const files = await scanner.scan("test/fixtures/sample-project");

            // Should find both event and command files (default behavior)
            expect(files.some((f) => f.includes("event-file.ts"))).toBe(true);
            expect(files.some((f) => f.includes("command-file.ts"))).toBe(true);
        });

        it("should work with custom decoratorNames combined with messageTypes", async () => {
            const tempDir = await mkdtemp(
                join(tmpdir(), "scanner-message-types-")
            );

            try {
                // Create files with custom decorators
                const eventFile = `
@ContractEvent()
export class OrderPlaced {}
`;
                const commandFile = `
@ContractCommand()
export class PlaceOrder {}
`;
                await writeFile(join(tempDir, "order-events.ts"), eventFile);
                await writeFile(
                    join(tempDir, "order-commands.ts"),
                    commandFile
                );

                // Scanner with custom decorators but only looking for events
                const scanner = new Scanner({
                    decoratorNames: {
                        event: "ContractEvent",
                        command: "ContractCommand",
                    },
                    messageTypes: ["event"],
                });
                const files = await scanner.scan(tempDir);

                // Should find only event file
                expect(files).toHaveLength(1);
                expect(files[0]).toContain("order-events.ts");
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
        });
    });
});
