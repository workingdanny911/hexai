import { Contract } from "@hexaijs/contracts/decorators";

@Contract({ kind: "snapshot", tags: ["frontend"] })
export class CatalogSnapshot {
    constructor(readonly items: readonly string[]) {}
}

// @Contract({ kind: "read-model", tags: ["frontend"] })
export interface CatalogReadModel {
    readonly id: string;
    readonly itemCount: number;
}

/** @Contract({ kind: "value-object" }) */
export type CatalogId = string;

/**
 * Internal statuses are selected only by an internal output.
 *
 * @Contract({ kind: "status", visibility: "internal", tags: ["ops"] })
 */
export enum InternalCatalogStatus {
    Rebuilding = "rebuilding",
    Failed = "failed",
}

class PrivateCatalogProjection {
    constructor(readonly snapshot: CatalogSnapshot) {}
}

