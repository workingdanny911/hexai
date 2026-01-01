import {
    PublicCommand,
    PublicEvent,
} from "@hexaijs/plugin-contracts-generator";
import { Message, DomainEvent } from "@hexaijs/core";

@PublicCommand()
export class CreateUserCommand extends Message<{
    username: string;
}> {}

@PublicEvent()
export class UserCreated extends DomainEvent<{
    userId: string;
}> {}
