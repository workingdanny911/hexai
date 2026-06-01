import { Message } from "@hexaijs/core";
import {
    Contract,
    ContractCommand,
    ContractEvent,
    ContractQuery,
    PublicCommand,
} from "@hexaijs/contracts/decorators";
import { ContractCommand as FakeContractCommand } from "./fake-decorators";
import { ContractCommand as InternalCommand } from "@hexaijs/contracts/decorators";

export interface CatalogItem {
    sku: string;
    title: string;
}

export interface CatalogSummary {
    total: number;
}

export interface SearchCatalogResult {
    items: CatalogItem[];
}

interface InternalRebuildPlan {
    shardCount: number;
}

export class InternalCatalogWorker {
    run(): string {
        return "internal";
    }
}

@ContractCommand()
export class CreateCatalogItemCommand extends Message<{
    item: CatalogItem;
}> {}

@InternalCommand({ visibility: "internal", tags: ["bus", "maintenance"] })
export class RebuildCatalogIndexCommand extends Message<{
    requestedBy: string;
    plan: InternalRebuildPlan;
}> {}

@Contract({ kind: "command", visibility: "internal", tags: ["bus"] })
export class RefreshCatalogCommand extends Message<{
    force: boolean;
}> {}

@ContractQuery({ response: "CatalogSummary" })
export class GetCatalogSummaryQuery extends Message<{
    catalogId: string;
}> {}

@Contract({ kind: "query", response: "SearchCatalogResult" })
export class SearchCatalogQuery extends Message<{
    term: string;
}> {}

@ContractEvent({ version: 2 })
export class CatalogItemPublishedEvent extends Message<{
    sku: string;
}> {
    static type = "catalog.item.published";
}

@Contract({ kind: "event" })
export class CatalogImportedEvent extends Message<{
    importedAt: string;
}> {}

@PublicCommand()
export class LegacyPublishCatalogCommand extends Message<{
    catalogId: string;
}> {}

@FakeContractCommand()
export class IgnoredFakeContractCommand extends Message<{
    shouldNotAppear: boolean;
}> {}
