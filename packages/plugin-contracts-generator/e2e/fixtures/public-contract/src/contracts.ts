import { PublicContract } from "@hexaijs/contracts";

// @PublicContract()
export interface PublicProfile {
    id: PublicUserId;
    email: string;
}

interface InternalProfileRecord {
    secretToken: string;
}

/** @PublicContract() */
export type PublicUserId = string;

function deriveDisplayName(email: string): string {
    return email.split("@")[0] ?? email;
}

const DEFAULT_STATUS = "active";

const Status = {
    Active: "active",
    Disabled: "disabled",
} as const;

class Factory {
    static create(): string {
        return "projection";
    }
}

@PublicContract()
export class PublicProjection {
    readonly status = DEFAULT_STATUS;
    readonly activeStatus = Status.Active;
    readonly projection = Factory.create();
    readonly displayName: string;

    constructor(
        readonly id: PublicUserId,
        email: string
    ) {
        this.displayName = deriveDisplayName(email);
    }
}

/**
 * Public statuses shared with clients.
 *
 * @PublicContract()
 */
export enum PublicStatus {
    Active = "active",
    Disabled = "disabled",
}

class InternalProjection {
    constructor(readonly record: InternalProfileRecord) {}

    status(): string {
        return DEFAULT_STATUS;
    }
}
