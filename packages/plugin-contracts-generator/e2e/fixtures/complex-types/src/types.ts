export type Id = string;
export type Timestamp = number;

export type Address = {
    street: string;
    city: string;
    country: string;
    zipCode?: string;
};

export type ContactInfo = {
    email: string;
    phone?: string;
    address?: Address;
};

export type Status = "pending" | "active" | "suspended" | "deleted";

export type Role = "admin" | "user" | "guest";

export type Permission = {
    resource: string;
    actions: string[];
};

export type UserProfile = {
    id: Id;
    name: string;
    contact: ContactInfo;
    status: Status;
    roles: Role[];
    permissions: Permission[];
    metadata?: Record<string, unknown>;
};

export type AuditInfo = {
    createdAt: Timestamp;
    createdBy: Id;
    updatedAt?: Timestamp;
    updatedBy?: Id;
};

export type PaginationParams = {
    page: number;
    pageSize: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
};

export type PaginatedResult<T> = {
    items: T[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
};

export type Result<T, E = string> =
    | { success: true; data: T }
    | { success: false; error: E };

export type Nested = {
    level1: {
        level2: {
            level3: {
                value: string;
            };
        };
    };
};
