import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextConfig } from "./context-config.js";
import { BoundaryViolationError, ConfigurationError } from "./errors.js";
import { ContractsPipeline } from "./pipeline.js";
import type { EntryStrategy } from "./domain/types.js";
import type { Logger } from "./logger.js";

describe("ContractsPipeline", () => {
    describe("entryStrategy validation", () => {
        it("should throw ConfigurationError for invalid programmatic entryStrategy", () => {
            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "file" as EntryStrategy,
                })
            ).toThrow(ConfigurationError);

            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "file" as EntryStrategy,
                })
            ).toThrow('Invalid entryStrategy: "file"');
        });
    });

    describe("output selection", () => {
        async function createTempProject(): Promise<{
            root: string;
            sourceDir: string;
            outputDir: string;
            cleanup(): Promise<void>;
        }> {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "messages.ts"),
                `
import { ContractCommand, ContractEvent, ContractQuery } from "@hexaijs/contracts/decorators";

@ContractQuery()
export class GetPublicCatalogQuery {}

@ContractEvent({ tags: ["frontend"] })
export class PublicCatalogChanged {}

@ContractCommand({ visibility: "internal", tags: ["bus"] })
export class RebuildInternalIndexCommand {}
`
            );

            return {
                root,
                sourceDir,
                outputDir,
                cleanup: () => rm(root, { recursive: true, force: true }),
            };
        }

        it("should exclude internal declarations from a public symbols output", async () => {
            const project = await createTempProject();

            try {
                const result = await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "catalog",
                        project.sourceDir
                    ),
                }).execute({
                    contextName: "catalog",
                    sourceDir: project.sourceDir,
                    outputDir: project.outputDir,
                    select: { visibility: ["public"] },
                });

                const content = await readFile(
                    join(project.outputDir, "catalog", "messages.ts"),
                    "utf-8"
                );

                expect(result.queries.map((query) => query.name)).toEqual([
                    "GetPublicCatalogQuery",
                ]);
                expect(result.events.map((event) => event.name)).toEqual([
                    "PublicCatalogChanged",
                ]);
                expect(result.commands).toHaveLength(0);
                expect(content).toContain("GetPublicCatalogQuery");
                expect(content).toContain("PublicCatalogChanged");
                expect(content).not.toContain("RebuildInternalIndexCommand");
            } finally {
                await project.cleanup();
            }
        });

        it("should intersect output selection with message kind filters", async () => {
            const project = await createTempProject();

            try {
                const result = await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "catalog",
                        project.sourceDir
                    ),
                    messageTypes: ["command"],
                }).execute({
                    contextName: "catalog",
                    sourceDir: project.sourceDir,
                    outputDir: project.outputDir,
                    select: {
                        visibility: ["internal"],
                        messageKinds: ["command"],
                        tags: { include: ["bus"] },
                    },
                });

                const content = await readFile(
                    join(project.outputDir, "catalog", "messages.ts"),
                    "utf-8"
                );

                expect(result.commands.map((command) => command.name)).toEqual([
                    "RebuildInternalIndexCommand",
                ]);
                expect(result.events).toHaveLength(0);
                expect(result.queries).toHaveLength(0);
                expect(content).toContain("RebuildInternalIndexCommand");
                expect(content).not.toContain("GetPublicCatalogQuery");
                expect(content).not.toContain("PublicCatalogChanged");
            } finally {
                await project.cleanup();
            }
        });

        it("should warn and fail fast when graph strategy would leak unselected declarations", async () => {
            const project = await createTempProject();
            const warnings: string[] = [];
            const logger: Logger = {
                debug: () => {},
                info: () => {},
                warn: (message) => warnings.push(message),
                error: () => {},
            };

            try {
                await expect(
                    ContractsPipeline.create({
                        contextConfig: ContextConfig.createSync(
                            "catalog",
                            project.sourceDir
                        ),
                        entryStrategy: "graph",
                        logger,
                    }).execute({
                        contextName: "catalog",
                        sourceDir: project.sourceDir,
                        outputDir: project.outputDir,
                        select: { visibility: ["public"] },
                    })
                ).rejects.toThrow(BoundaryViolationError);

                expect(warnings).toContainEqual(
                    expect.stringContaining(
                        "Use entryStrategy 'symbols' for strict public/internal output splits"
                    )
                );
            } finally {
                await project.cleanup();
            }
        });

        it("should pass trusted decorator sources through scanner, parser, and copier", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "messages.ts"),
                `
import { ContractCommand } from "@app/contracts";

@ContractCommand()
export class CreateUserCommand {}
`
            );

            try {
                const result = await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync("app", sourceDir),
                    trustedDecoratorSources: ["@app/contracts"],
                }).execute({
                    contextName: "app",
                    sourceDir,
                    outputDir,
                    removeDecorators: true,
                });

                const content = await readFile(
                    join(outputDir, "app", "messages.ts"),
                    "utf-8"
                );

                expect(result.commands.map((command) => command.name)).toEqual([
                    "CreateUserCommand",
                ]);
                expect(content).not.toContain("@ContractCommand");
                expect(content).not.toContain("@app/contracts");
                expect(content).toContain("export class CreateUserCommand");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should fail a public symbols output when its import graph reaches an internal marked dependency file", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(join(sourceDir, "internal"), { recursive: true });
            await writeFile(
                join(sourceDir, "contract-markers.ts"),
                `
export { ContractQuery } from "@hexaijs/contracts/decorators";
`
            );
            await writeFile(
                join(sourceDir, "public-query.ts"),
                `
import { ContractQuery } from "./contract-markers";
import { QAInternalShape } from "./internal/qa-internal-shape";

@ContractQuery()
export class GetQAReferenceDataQuery {
    readonly shape!: QAInternalShape;
}
`
            );
            await writeFile(
                join(sourceDir, "internal", "qa-internal-shape.ts"),
                `
// @Contract({ kind: "shape", visibility: "internal" })
export interface QAInternalShape {
    readonly secretToken: string;
}
`
            );

            try {
                let thrown: unknown;
                try {
                    await ContractsPipeline.create({
                        contextConfig: ContextConfig.createSync(
                            "reference-data",
                            sourceDir
                        ),
                        trustedDecoratorSources: ["./contract-markers"],
                    }).execute({
                        contextName: "reference-data",
                        sourceDir,
                        outputDir,
                        removeDecorators: true,
                        select: { visibility: ["public"] },
                    });
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(BoundaryViolationError);
                expect((thrown as Error).message).toMatch(
                    /QAInternalShape.*visibility=internal/
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should not copy a trusted decorator-only local barrel into generated output", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "contract-markers.ts"),
                `
export { ContractQuery, ContractCommand } from "@hexaijs/contracts/decorators";
`
            );
            await writeFile(
                join(sourceDir, "public-query.ts"),
                `
import { ContractQuery } from "./contract-markers";

@ContractQuery()
export class GetPublicCatalogQuery {}
`
            );

            try {
                const result = await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "catalog",
                        sourceDir
                    ),
                    trustedDecoratorSources: ["./contract-markers"],
                }).execute({
                    contextName: "catalog",
                    sourceDir,
                    outputDir,
                    removeDecorators: true,
                    select: { visibility: ["public"] },
                });

                const content = await readFile(
                    join(outputDir, "catalog", "public-query.ts"),
                    "utf-8"
                );
                const indexContent = await readFile(
                    join(outputDir, "catalog", "index.ts"),
                    "utf-8"
                );

                expect(result.copiedFiles.map((file) => file.replace(/\\/g, "/"))).not.toContain(
                    join(outputDir, "catalog", "contract-markers.ts").replace(/\\/g, "/")
                );
                expect(content).toContain("GetPublicCatalogQuery");
                expect(content).not.toContain("./contract-markers");
                expect(content).not.toContain("@ContractQuery");
                expect(indexContent).not.toContain("contract-markers");
                await expect(
                    readFile(
                        join(outputDir, "catalog", "contract-markers.ts"),
                        "utf-8"
                    )
                ).rejects.toThrow();
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    });
});
