import { Message } from "@hexaijs/core";
import { PublicCommand } from "@/decorators";
import type { UserId, UserStatus } from "./domain";
import { Email } from "./domain";

@PublicCommand()
export class CreateUserCommand extends Message<{
    userId: UserId;
    email: Email;
    status: UserStatus;
}> {}
