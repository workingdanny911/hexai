import { Message } from "@hexaijs/core";
import { PublicCommand } from "@/decorators";
import type { UserId, UserProfile } from "./types";

@PublicCommand()
export class CreateUser extends Message<{
    profile: UserProfile;
}> {}

@PublicCommand()
export class DeleteUser extends Message<{
    userId: UserId;
    reason?: string;
}> {}
