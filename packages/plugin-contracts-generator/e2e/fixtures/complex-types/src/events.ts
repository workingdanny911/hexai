import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import type {
    Id,
    UserProfile,
    AuditInfo,
    Status,
    Role,
    Permission,
    Address,
    ContactInfo,
    Nested,
} from "./types";

@PublicEvent()
export class UserCreated extends Message<
    AuditInfo & {
        profile: UserProfile;
        initialPassword?: string;
    }
> {}

@PublicEvent()
export class UserStatusChanged extends Message<{
    userId: Id;
    previousStatus: Status;
    newStatus: Status;
    reason?: string;
    changedAt: number;
    changedBy: Id;
}> {}

@PublicEvent()
export class UserRolesUpdated extends Message<{
    userId: Id;
    addedRoles: Role[];
    removedRoles: Role[];
    permissions: Permission[];
}> {}

@PublicEvent()
export class UserAddressUpdated extends Message<{
    userId: Id;
    oldAddress?: Address;
    newAddress: Address;
    contactInfo: ContactInfo;
}> {}

@PublicEvent()
export class NestedDataProcessed extends Message<{
    id: Id;
    nested: Nested;
    flatValue: string;
}> {}

@PublicEvent()
export class BatchUsersProcessed extends Message<{
    batchId: Id;
    users: UserProfile[];
    processedAt: number;
    summary: {
        total: number;
        succeeded: number;
        failed: number;
        errors?: Array<{ userId: Id; error: string }>;
    };
}> {}
