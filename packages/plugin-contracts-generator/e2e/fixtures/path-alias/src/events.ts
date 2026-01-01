import { Message } from "@hexaijs/core";
import { PublicEvent } from "@/decorators";
import type { UserId, UserProfile } from "./types";

@PublicEvent()
export class UserCreated extends Message<{
    profile: UserProfile;
    createdAt: string;
}> {}

@PublicEvent()
export class UserDeleted extends Message<{
    userId: UserId;
    deletedAt: string;
}> {}
