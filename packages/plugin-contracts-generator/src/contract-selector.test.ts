import { describe, expect, it } from "vitest";

import {
    hasStrictOutputSelection,
    isContractSelected,
} from "./contract-selector.js";

describe("isContractSelected", () => {
    it("should select every contract when select config is missing", () => {
        expect(isContractSelected({ name: "AnyContract" }, undefined)).toBe(true);
    });

    it("should filter by visibility", () => {
        expect(
            isContractSelected(
                { name: "PublicQuery", messageType: "query", visibility: "public" },
                { visibility: ["public"] }
            )
        ).toBe(true);
        expect(
            isContractSelected(
                { name: "InternalQuery", messageType: "query", visibility: "internal" },
                { visibility: ["public"] }
            )
        ).toBe(false);
    });

    it("should distinguish messages from general contracts", () => {
        expect(
            isContractSelected(
                { name: "CreateUser", messageType: "command" },
                { include: "messages" }
            )
        ).toBe(true);
        expect(
            isContractSelected(
                { name: "UserSnapshot", contractType: "contract", kind: "snapshot" },
                { include: "messages" }
            )
        ).toBe(false);
        expect(
            isContractSelected(
                { name: "UserSnapshot", contractType: "contract", kind: "snapshot" },
                { include: "contracts" }
            )
        ).toBe(true);
    });

    it("should filter by built-in and custom kinds", () => {
        expect(
            isContractSelected(
                { name: "CreateUser", messageType: "command" },
                { kinds: ["command"] }
            )
        ).toBe(true);
        expect(
            isContractSelected(
                { name: "UserSnapshot", contractType: "contract", kind: "snapshot" },
                { kinds: ["snapshot"] }
            )
        ).toBe(true);
        expect(
            isContractSelected(
                { name: "UserSnapshot", contractType: "contract", kind: "snapshot" },
                { kinds: ["read-model"] }
            )
        ).toBe(false);
    });

    it("should apply messageKinds only to message declarations", () => {
        expect(
            isContractSelected(
                { name: "GetUser", messageType: "query" },
                { messageKinds: ["query"] }
            )
        ).toBe(true);
        expect(
            isContractSelected(
                { name: "UserSnapshot", contractType: "contract", kind: "query" },
                { messageKinds: ["query"] }
            )
        ).toBe(false);
        expect(
            isContractSelected(
                { name: "CreateUser", contractType: "message", kind: "command" },
                { messageKinds: ["command"] }
            )
        ).toBe(true);
    });

    it("should match any included tag and reject excluded tags", () => {
        const contract = {
            name: "AdminSnapshot",
            contractType: "contract" as const,
            kind: "snapshot",
            tags: ["admin", "frontend"],
        };

        expect(
            isContractSelected(contract, {
                tags: { include: ["admin", "frontend"] },
            })
        ).toBe(true);
        expect(
            isContractSelected(contract, {
                tags: { include: ["admin", "mobile"] },
            })
        ).toBe(true);
        expect(
            isContractSelected(contract, {
                tags: { include: ["mobile", "ops"] },
            })
        ).toBe(false);
        expect(
            isContractSelected(contract, {
                tags: { exclude: ["frontend"] },
            })
        ).toBe(false);
    });

    it("should treat missing or empty included tags as a no-op", () => {
        const contract = {
            name: "PublicSnapshot",
            contractType: "contract" as const,
            kind: "snapshot",
            tags: ["frontend"],
        };

        expect(isContractSelected(contract, { tags: {} })).toBe(true);
        expect(
            isContractSelected(contract, {
                tags: { include: [] },
            })
        ).toBe(true);
    });

    it("should identify strict output selection predicates", () => {
        expect(hasStrictOutputSelection(undefined)).toBe(false);
        expect(hasStrictOutputSelection({})).toBe(false);
        expect(hasStrictOutputSelection({ tags: { include: [] } })).toBe(false);

        expect(hasStrictOutputSelection({ include: "messages" })).toBe(true);
        expect(hasStrictOutputSelection({ visibility: ["internal"] })).toBe(true);
        expect(hasStrictOutputSelection({ tags: { exclude: ["server"] } })).toBe(true);
    });
});
