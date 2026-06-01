import { describe, expect, it } from "vitest";

import {
    Contract,
    ContractCommand,
    ContractEvent,
    ContractQuery,
    PublicCommand,
    PublicContract,
    PublicEvent,
    PublicQuery,
    type ContractCommandOptions,
    type ContractEventOptions,
    type ContractQueryOptions,
} from "./index.js";

describe("public contract decorators", () => {
    it("should expose PublicContract as a no-op class decorator", () => {
        class PublicProjection {}

        const decorator = PublicContract();
        const result = decorator(PublicProjection);

        expect(result).toBe(PublicProjection);
    });

    it("should keep existing public message decorators as no-op class decorators", () => {
        class PublicMessage {}

        expect(PublicEvent()(PublicMessage)).toBe(PublicMessage);
        expect(PublicCommand()(PublicMessage)).toBe(PublicMessage);
        expect(PublicQuery()(PublicMessage)).toBe(PublicMessage);
    });

    it("should expose Contract decorators as no-op class decorators", () => {
        class ContractMessage {}

        expect(Contract()(ContractMessage)).toBe(ContractMessage);
        expect(ContractEvent()(ContractMessage)).toBe(ContractMessage);
        expect(ContractCommand()(ContractMessage)).toBe(ContractMessage);
        expect(ContractQuery()(ContractMessage)).toBe(ContractMessage);
    });

    it("should keep legacy Public decorators as runtime aliases", () => {
        expect(PublicContract).toBe(Contract);
        expect(PublicEvent).toBe(ContractEvent);
        expect(PublicCommand).toBe(ContractCommand);
        expect(PublicQuery).toBe(ContractQuery);
    });

    it("should keep message-specific option types narrow", () => {
        const eventOptions = {
            visibility: "public",
            tags: ["audit"],
            context: "users",
            version: 2,
        } satisfies ContractEventOptions;
        const commandOptions = {
            visibility: "internal",
            response: "CreateUserResult",
        } satisfies ContractCommandOptions;
        const queryOptions = {
            response: "UserProfile",
        } satisfies ContractQueryOptions;

        // @ts-expect-error events do not accept response metadata.
        const invalidEventOptions = { response: "EventResult" } satisfies ContractEventOptions;
        // @ts-expect-error commands do not accept event version metadata.
        const invalidCommandOptions = { version: 2 } satisfies ContractCommandOptions;
        // @ts-expect-error queries do not accept event version metadata.
        const invalidQueryOptions = { version: 2 } satisfies ContractQueryOptions;

        expect(eventOptions.version).toBe(2);
        expect(commandOptions.response).toBe("CreateUserResult");
        expect(queryOptions.response).toBe("UserProfile");
        void invalidEventOptions;
        void invalidCommandOptions;
        void invalidQueryOptions;
    });
});
