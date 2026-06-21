import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextConfig } from "./context-config.js";
import {
    BoundaryViolationError,
    ConfigurationError,
    UnsafeDependencySliceError,
} from "./errors.js";
import { ContractsPipeline } from "./pipeline.js";
import type { DependencyStrategy } from "./domain/types.js";

describe("ContractsPipeline", () => {
    describe("removed entryStrategy validation", () => {
        it("should throw ConfigurationError for stale programmatic entryStrategy", () => {
            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "graph",
                } as unknown as Parameters<typeof ContractsPipeline.create>[0])
            ).toThrow(ConfigurationError);

            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    entryStrategy: "graph",
                } as unknown as Parameters<typeof ContractsPipeline.create>[0])
            ).toThrow("entryStrategy has been removed");
        });
    });

    describe("dependencyStrategy validation", () => {
        it("should throw ConfigurationError for invalid programmatic dependencyStrategy", () => {
            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    dependencyStrategy: "minimal" as DependencyStrategy,
                })
            ).toThrow(ConfigurationError);

            expect(() =>
                ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "lecture",
                        "/tmp/lecture"
                    ),
                    dependencyStrategy: "minimal" as DependencyStrategy,
                })
            ).toThrow('Invalid dependencyStrategy: "minimal"');
        });
    });

    describe("safe-symbol dependency slicing", () => {
        async function createSafeSymbolsProject(): Promise<{
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
                join(sourceDir, "profile-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";
import { QueryBase, UsedProfile, buildProfileLabel, UnusedProfile } from "./profile-dependencies.js";
import type { TypeOnlyShape } from "./type-only-shape.js";

@ContractQuery()
export class GetProfileQuery extends QueryBase {
    readonly profile!: UsedProfile;
    readonly typeOnly!: TypeOnlyShape;

    static label(profile: UsedProfile): string {
        return buildProfileLabel(profile);
    }
}
`
            );
            await writeFile(
                join(sourceDir, "profile-dependencies.ts"),
                `
import { formatProfileId, unusedFormat } from "./transitive-formatters.js";

interface ProfileMetadata {
    readonly prefix: string;
}

const localPrefix = "profile";

export abstract class QueryBase {
    readonly queryId = formatProfileId("root");
}

export interface UsedProfile extends ProfileMetadata {
    readonly id: string;
}

export function buildProfileLabel(profile: UsedProfile): string {
    return localPrefix + ":" + formatProfileId(profile.id);
}

export interface UnusedProfile {
    readonly id: string;
}

export function unusedProfileLabel(profile: UnusedProfile): string {
    return unusedFormat(profile.id);
}
`
            );
            await writeFile(
                join(sourceDir, "transitive-formatters.ts"),
                `
export function formatProfileId(id: string): string {
    return "profile-" + id;
}

export function unusedFormat(value: string): string {
    return "unused-" + value;
}
`
            );
            await writeFile(
                join(sourceDir, "type-only-shape.ts"),
                `
export interface TypeOnlyShape {
    readonly shapeId: string;
}

export interface UnusedTypeOnlyShape {
    readonly unusedId: string;
}
`
            );

            return {
                root,
                sourceDir,
                outputDir,
                cleanup: () => rm(root, { recursive: true, force: true }),
            };
        }

        async function readGenerated(
            outputDir: string,
            fileName: string,
            contextName = "profiles"
        ): Promise<string> {
            return readFile(join(outputDir, contextName, fileName), "utf-8");
        }

        it("should slice dependency files to retained runtime and type symbols by default", async () => {
            const project = await createSafeSymbolsProject();

            try {
                await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "profiles",
                        project.sourceDir
                    ),
                }).execute({
                    contextName: "profiles",
                    sourceDir: project.sourceDir,
                    outputDir: project.outputDir,
                });

                const entryContent = await readGenerated(
                    project.outputDir,
                    "profile-query.ts"
                );
                const dependencyContent = await readGenerated(
                    project.outputDir,
                    "profile-dependencies.ts"
                );
                const transitiveContent = await readGenerated(
                    project.outputDir,
                    "transitive-formatters.ts"
                );
                const typeOnlyContent = await readGenerated(
                    project.outputDir,
                    "type-only-shape.ts"
                );

                expect(entryContent).toContain(
                    'from "./profile-dependencies.js"'
                );
                expect(entryContent).toContain(
                    'from "./type-only-shape.js"'
                );
                expect(entryContent).not.toContain("UnusedProfile");
                expect(dependencyContent).toContain("export abstract class QueryBase");
                expect(dependencyContent).toContain("interface ProfileMetadata");
                expect(dependencyContent).toContain("const localPrefix");
                expect(dependencyContent).toContain("export interface UsedProfile");
                expect(dependencyContent).toContain("export function buildProfileLabel");
                expect(dependencyContent).toContain(
                    'from "./transitive-formatters.js"'
                );
                expect(dependencyContent).not.toContain("UnusedProfile");
                expect(dependencyContent).not.toContain("unusedProfileLabel");
                expect(dependencyContent).not.toContain("unusedFormat");
                expect(transitiveContent).toContain("export function formatProfileId");
                expect(transitiveContent).not.toContain("unusedFormat");
                expect(typeOnlyContent).toContain("export interface TypeOnlyShape");
                expect(typeOnlyContent).not.toContain("UnusedTypeOnlyShape");
            } finally {
                await project.cleanup();
            }
        });

        it("should keep full dependency file behavior when dependencyStrategy is file", async () => {
            const project = await createSafeSymbolsProject();

            try {
                await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "profiles",
                        project.sourceDir
                    ),
                    dependencyStrategy: "file",
                }).execute({
                    contextName: "profiles",
                    sourceDir: project.sourceDir,
                    outputDir: project.outputDir,
                });

                const dependencyContent = await readGenerated(
                    project.outputDir,
                    "profile-dependencies.ts"
                );
                const transitiveContent = await readGenerated(
                    project.outputDir,
                    "transitive-formatters.ts"
                );

                expect(dependencyContent).toContain("UnusedProfile");
                expect(dependencyContent).toContain("unusedProfileLabel");
                expect(transitiveContent).toContain("unusedFormat");
            } finally {
                await project.cleanup();
            }
        });

        it("should copy outside-source-root shared dependencies whole before safe slicing", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "contexts", "profiles");
            const sharedDir = join(root, "contexts", "shared");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await mkdir(sharedDir, { recursive: true });
            await writeFile(
                join(sourceDir, "profile-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";
import { SharedShape } from "../shared/shared-shape.js";

@ContractQuery()
export class GetProfileQuery {
    readonly shared!: SharedShape;
}
`
            );
            await writeFile(
                join(sharedDir, "shared-shape.ts"),
                `
import "./setup.js";
import { SharedToken } from "./shared-token.js";

export interface SharedShape {
    readonly token: SharedToken;
}

export interface UnusedSharedShape {
    readonly unused: string;
}
`
            );
            await writeFile(
                join(sharedDir, "shared-token.ts"),
                `
export interface SharedToken {
    readonly id: string;
}
`
            );
            await writeFile(
                join(sharedDir, "setup.ts"),
                `
registerSharedContracts();

function registerSharedContracts(): void {}
`
            );

            try {
                await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "profiles",
                        sourceDir
                    ),
                }).execute({
                    contextName: "profiles",
                    sourceDir,
                    outputDir,
                });

                const sharedShapeContent = await readFile(
                    join(outputDir, "shared", "shared-shape.ts"),
                    "utf-8"
                );
                const setupContent = await readFile(
                    join(outputDir, "shared", "setup.ts"),
                    "utf-8"
                );
                const tokenContent = await readFile(
                    join(outputDir, "shared", "shared-token.ts"),
                    "utf-8"
                );

                expect(sharedShapeContent).toContain('import "./setup.js"');
                expect(sharedShapeContent).toContain("UnusedSharedShape");
                expect(setupContent).toContain("registerSharedContracts()");
                expect(tokenContent).toContain("export interface SharedToken");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should not slice entry point files imported by other extracted entries", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "a-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";
import { SharedShape } from "./b-query.js";

@ContractQuery()
export class AQuery {
    readonly shared!: SharedShape;
}
`
            );
            await writeFile(
                join(sourceDir, "b-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";

export interface SharedShape {
    readonly id: string;
}

@ContractQuery()
export class BQuery {
    readonly shared!: SharedShape;
}
`
            );

            try {
                await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "cross-entry",
                        sourceDir
                    ),
                    dependencyStrategy: "safe-symbols",
                }).execute({
                    contextName: "cross-entry",
                    sourceDir,
                    outputDir,
                });

                const aQueryContent = await readGenerated(
                    outputDir,
                    "a-query.ts",
                    "cross-entry"
                );
                const bQueryContent = await readGenerated(
                    outputDir,
                    "b-query.ts",
                    "cross-entry"
                );

                expect(aQueryContent).toContain('from "./b-query.js"');
                expect(bQueryContent).toContain("export interface SharedShape");
                expect(bQueryContent).toContain("export class BQuery");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should reject safe-symbols dependency slicing when top-level side effects are present", async () => {
            const project = await createSafeSymbolsProject();
            await writeFile(
                join(project.sourceDir, "profile-dependencies.ts"),
                `
import { formatProfileId, unusedFormat } from "./transitive-formatters.js";

registerProfileDependency();

function registerProfileDependency(): void {}

export abstract class QueryBase {
    readonly queryId = formatProfileId("root");
}

export interface UsedProfile {
    readonly id: string;
}

export function buildProfileLabel(profile: UsedProfile): string {
    return formatProfileId(profile.id);
}

export interface UnusedProfile {
    readonly id: string;
}

export function unusedProfileLabel(profile: UnusedProfile): string {
    return unusedFormat(profile.id);
}
`
            );

            try {
                const execution = ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "profiles",
                        project.sourceDir
                    ),
                    dependencyStrategy: "safe-symbols",
                }).execute({
                    contextName: "profiles",
                    sourceDir: project.sourceDir,
                    outputDir: project.outputDir,
                });

                await expect(execution).rejects.toThrow(
                    UnsafeDependencySliceError
                );
                await expect(execution).rejects.toMatchObject({
                    filePath: join(
                        project.sourceDir,
                        "profile-dependencies.ts"
                    ),
                    reason: expect.stringContaining("top-level statement"),
                });
            } finally {
                await project.cleanup();
            }
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
                const execution = ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "reference-data",
                        sourceDir
                    ),
                    dependencyStrategy: "file",
                    trustedDecoratorSources: ["./contract-markers"],
                }).execute({
                    contextName: "reference-data",
                    sourceDir,
                    outputDir,
                    removeDecorators: true,
                    select: { visibility: ["public"] },
                });

                await expect(execution).rejects.toThrow(BoundaryViolationError);
                await expect(execution).rejects.toThrow(
                    /QAInternalShape.*visibility=internal/
                );
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should pass strict public selection when safe slicing removes an unused internal marked dependency declaration", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "public-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";
import { PublicDependencyShape } from "./dependency-shapes.js";

@ContractQuery()
export class GetPublicDependencyQuery {
    readonly shape!: PublicDependencyShape;
}
`
            );
            await writeFile(
                join(sourceDir, "dependency-shapes.ts"),
                `
export interface PublicDependencyShape {
    readonly id: string;
}

// @Contract({ kind: "shape", visibility: "internal" })
export interface InternalDependencyShape {
    readonly secret: string;
}
`
            );

            try {
                await ContractsPipeline.create({
                    contextConfig: ContextConfig.createSync(
                        "reference-data",
                        sourceDir
                    ),
                    dependencyStrategy: "safe-symbols",
                }).execute({
                    contextName: "reference-data",
                    sourceDir,
                    outputDir,
                    removeDecorators: true,
                    select: { visibility: ["public"] },
                });

                const content = await readFile(
                    join(outputDir, "reference-data", "dependency-shapes.ts"),
                    "utf-8"
                );

                expect(content).toContain("PublicDependencyShape");
                expect(content).not.toContain("InternalDependencyShape");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        });

        it("should reject unsafe safe-symbols dependencies before strict public selection checks", async () => {
            const root = await mkdtemp(join(tmpdir(), "contracts-pipeline-"));
            const sourceDir = join(root, "src");
            const outputDir = join(root, "contracts");
            await mkdir(sourceDir, { recursive: true });
            await writeFile(
                join(sourceDir, "public-query.ts"),
                `
import { ContractQuery } from "@hexaijs/contracts/decorators";
import { PublicDependencyShape } from "./dependency-shapes.js";

@ContractQuery()
export class GetPublicDependencyQuery {
    readonly shape!: PublicDependencyShape;
}
`
            );
            await writeFile(
                join(sourceDir, "dependency-shapes.ts"),
                `
registerDependencyShapes();

function registerDependencyShapes(): void {}

export interface PublicDependencyShape {
    readonly id: string;
}

// @Contract({ kind: "shape", visibility: "internal" })
export interface InternalDependencyShape {
    readonly secret: string;
}
`
            );

            try {
                await expect(
                    ContractsPipeline.create({
                        contextConfig: ContextConfig.createSync(
                            "reference-data",
                            sourceDir
                        ),
                        dependencyStrategy: "safe-symbols",
                    }).execute({
                        contextName: "reference-data",
                        sourceDir,
                        outputDir,
                        removeDecorators: true,
                        select: { visibility: ["public"] },
                    })
                ).rejects.toThrow(UnsafeDependencySliceError);
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
