import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Scanner } from "./scanner.js";
import type { DecoratorNames, MessageType } from "./domain/index.js";

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

    it("should find files containing @PublicContract comment markers or class decorators", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "scanner-contract-"));

        try {
            await writeFile(
                join(tempDir, "line-contract.ts"),
                `
// @PublicContract()
export interface PublicProfile {
    id: string;
}
`
            );
            await writeFile(
                join(tempDir, "jsdoc-contract.ts"),
                `
/**
 * @PublicContract()
 */
export type PublicSettings = {
    theme: string;
};
`
            );
            await writeFile(
                join(tempDir, "block-contract.ts"),
                `
/* @PublicContract() */
export enum PublicVisibility {
    Visible = "visible",
}
`
            );
            await writeFile(
                join(tempDir, "decorator-contract.ts"),
                `
@PublicContract()
export class PublicProjection {
    readonly id = "projection";
}
`
            );
            await writeFile(
                join(tempDir, "internal.ts"),
                `
export interface InternalProfile {
    id: string;
}
`
            );

            const scanner = new Scanner();
            const files = await scanner.scan(tempDir);

            expect(files).toHaveLength(4);
            expect(files.some((f) => f.includes("line-contract.ts"))).toBe(
                true
            );
            expect(files.some((f) => f.includes("jsdoc-contract.ts"))).toBe(
                true
            );
            expect(files.some((f) => f.includes("block-contract.ts"))).toBe(
                true
            );
            expect(
                files.some((f) => f.includes("decorator-contract.ts"))
            ).toBe(true);
            expect(files.some((f) => f.includes("internal.ts"))).toBe(false);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("should not match longer identifiers that start with PublicContract", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "scanner-contract-"));

        try {
            await writeFile(
                join(tempDir, "false-positive.ts"),
                `
// @PublicContractual()
export interface InternalProfile {
    id: string;
}
`
            );

            const scanner = new Scanner();
            const files = await scanner.scan(tempDir);

            expect(files).toHaveLength(0);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("should not scan prose comments that mention marker-shaped Contract calls", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "scanner-contract-"));

        try {
            await writeFile(
                join(tempDir, "prose.ts"),
                `
/**
 * This is documentation prose mentioning @Contract({ kind: "read-model" }).
 */
export interface InternalProfile {
    id: string;
}
`
            );

            const scanner = new Scanner();
            const files = await scanner.scan(tempDir);

            expect(files).toHaveLength(0);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
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

            // Act: Default canonical Contract* decorators require a trusted import binding.
            const scannerWithDefaults = new Scanner();
            const filesWithDefaults = await scannerWithDefaults.scan(tempDir);

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

    describe("Contract API scanner integration", () => {
        it("should find canonical, generic, alias, comment marker, and legacy contract files", async () => {
            const tempDir = await mkdtemp(join(tmpdir(), "scanner-contract-api-"));

            try {
                await writeFile(
                    join(tempDir, "canonical-command.ts"),
                    `
import { ContractCommand } from "@hexaijs/contracts";

@ContractCommand()
export class CreateUser {}
`
                );
                await writeFile(
                    join(tempDir, "canonical-query.ts"),
                    `
import { ContractQuery } from "@hexaijs/contracts";

@ContractQuery()
export class GetUser {}
`
                );
                await writeFile(
                    join(tempDir, "canonical-event.ts"),
                    `
import { ContractEvent } from "@hexaijs/contracts";

@ContractEvent()
export class UserCreated {}
`
                );
                await writeFile(
                    join(tempDir, "generic-message.ts"),
                    `
import { Contract } from "@hexaijs/contracts";

@Contract({ kind: "command" })
export class RebuildUser {}
`
                );
                await writeFile(
                    join(tempDir, "generic-contract.ts"),
                    `
import { Contract } from "@hexaijs/contracts";

@Contract({ kind: "read-model" })
export class UserReadModel {}
`
                );
                await writeFile(
                    join(tempDir, "alias-command.ts"),
                    `
import { ContractCommand as InternalCommand } from "@hexaijs/contracts";

@InternalCommand()
export class CreateAdmin {}
`
                );
                await writeFile(
                    join(tempDir, "comment-contract.ts"),
                    `
// @Contract({ kind: "read-model", visibility: "internal", tags: ["admin"] })
export interface AdminReadModel {
    id: string;
}
`
                );
                await writeFile(
                    join(tempDir, "legacy-event.ts"),
                    `
@PublicEvent()
export class LegacyUserCreated {}
`
                );
                await writeFile(
                    join(tempDir, "internal.ts"),
                    `
export class InternalHelper {}
`
                );

                const scanner = new Scanner();
                const files = await scanner.scan(tempDir);

                expect(files).toHaveLength(8);
                expect(files.some((f) => f.includes("canonical-command.ts"))).toBe(true);
                expect(files.some((f) => f.includes("canonical-query.ts"))).toBe(true);
                expect(files.some((f) => f.includes("canonical-event.ts"))).toBe(true);
                expect(files.some((f) => f.includes("generic-message.ts"))).toBe(true);
                expect(files.some((f) => f.includes("generic-contract.ts"))).toBe(true);
                expect(files.some((f) => f.includes("alias-command.ts"))).toBe(true);
                expect(files.some((f) => f.includes("comment-contract.ts"))).toBe(true);
                expect(files.some((f) => f.includes("legacy-event.ts"))).toBe(true);
                expect(files.some((f) => f.includes("internal.ts"))).toBe(false);
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
        });

        it("should find canonical decorators from configured trusted sources", async () => {
            const tempDir = await mkdtemp(join(tmpdir(), "scanner-contract-api-"));

            try {
                await writeFile(
                    join(tempDir, "trusted-command.ts"),
                    `
import { ContractCommand } from "@app/contracts";

@ContractCommand()
export class CreateUser {}
`
                );

                const scanner = new Scanner({
                    trustedDecoratorSources: ["@app/contracts"],
                });
                const files = await scanner.scan(tempDir);

                expect(files).toHaveLength(1);
                expect(files[0]).toContain("trusted-command.ts");
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
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

        it("should not include PublicContract-only files when messageTypes is ['event']", async () => {
            const tempDir = await mkdtemp(
                join(tmpdir(), "scanner-message-types-")
            );

            try {
                await writeFile(
                    join(tempDir, "contracts.ts"),
                    `
// @PublicContract()
export type PublicUserId = string;
`
                );
                await writeFile(
                    join(tempDir, "events.ts"),
                    `
@PublicEvent()
export class UserRegistered {}
`
                );

                const scanner = new Scanner({
                    messageTypes: ["event"],
                });
                const files = await scanner.scan(tempDir);

                expect(files).toHaveLength(1);
                expect(files[0]).toContain("events.ts");
            } finally {
                await rm(tempDir, { recursive: true, force: true });
            }
        });
    });
});
