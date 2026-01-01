import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import type {
    Id,
    Role,
    Permission,
    Address,
    ContactInfo,
    Status,
    PaginationParams,
} from "./types";

@PublicCommand()
export class CreateUser extends Message<{
    name: string;
    email: string;
    contact?: ContactInfo;
    initialRoles?: Role[];
    initialStatus?: Status;
}> {}

@PublicCommand()
export class UpdateUserRoles extends Message<{
    userId: Id;
    rolesToAdd?: Role[];
    rolesToRemove?: Role[];
    permissions?: Permission[];
}> {}

@PublicCommand()
export class UpdateUserAddress extends Message<{
    userId: Id;
    address: Address;
    setAsPrimary?: boolean;
}> {}

@PublicCommand()
export class SearchUsers extends Message<
    PaginationParams & {
        filters?: {
            status?: Status[];
            roles?: Role[];
            createdAfter?: number;
            createdBefore?: number;
        };
        includeDeleted?: boolean;
    }
> {}

@PublicCommand()
export class BatchUpdateStatus extends Message<{
    userIds: Id[];
    newStatus: Status;
    reason: string;
    notifyUsers?: boolean;
}> {}
