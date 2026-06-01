import type {
    ContractKind,
    ContractOutputSelect,
    ContractVisibility,
    MessageContractKind,
} from "./domain/index.js";
import { toMessageType } from "./domain/index.js";

export interface SelectableContract {
    readonly name: string;
    readonly contractType?: "message" | "contract";
    readonly kind?: ContractKind;
    readonly messageType?: MessageContractKind;
    readonly visibility?: ContractVisibility;
    readonly tags?: readonly string[];
}

export function isContractSelected(
    contract: SelectableContract,
    select: ContractOutputSelect | undefined
): boolean {
    if (!select) {
        return true;
    }

    const contractType = getContractType(contract);
    const kind = contract.kind ?? contract.messageType ?? "contract";
    const visibility = contract.visibility ?? "public";
    const tags = contract.tags ?? [];

    if (select.include === "messages" && contractType !== "message") {
        return false;
    }

    if (select.include === "contracts" && contractType !== "contract") {
        return false;
    }

    if (
        select.visibility &&
        select.visibility.length > 0 &&
        !select.visibility.includes(visibility)
    ) {
        return false;
    }

    if (
        select.kinds &&
        select.kinds.length > 0 &&
        !select.kinds.includes(kind)
    ) {
        return false;
    }

    if (select.messageKinds && select.messageKinds.length > 0) {
        if (contractType !== "message") {
            return false;
        }

        const messageKind = contract.messageType ?? toMessageType(kind);
        if (!messageKind || !select.messageKinds.includes(messageKind)) {
            return false;
        }
    }

    if (select.tags?.include && select.tags.include.length > 0) {
        const hasIncludedTag = select.tags.include.some((tag) =>
            tags.includes(tag)
        );
        if (!hasIncludedTag) {
            return false;
        }
    }

    if (select.tags?.exclude && select.tags.exclude.length > 0) {
        const hasExcludedTag = select.tags.exclude.some((tag) =>
            tags.includes(tag)
        );
        if (hasExcludedTag) {
            return false;
        }
    }

    return true;
}

export function hasStrictOutputSelection(
    select: ContractOutputSelect | undefined
): boolean {
    if (!select) return false;

    return Boolean(
        select.include ||
            (select.visibility && select.visibility.length > 0) ||
            (select.kinds && select.kinds.length > 0) ||
            (select.messageKinds && select.messageKinds.length > 0) ||
            (select.tags?.include && select.tags.include.length > 0) ||
            (select.tags?.exclude && select.tags.exclude.length > 0)
    );
}

function getContractType(contract: SelectableContract): "message" | "contract" {
    if (contract.contractType) {
        return contract.contractType;
    }

    return contract.messageType ? "message" : "contract";
}
