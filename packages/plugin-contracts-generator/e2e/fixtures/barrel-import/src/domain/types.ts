export type UserId = string & { readonly __brand: "UserId" };

export type UserStatus = "active" | "inactive" | "pending";
