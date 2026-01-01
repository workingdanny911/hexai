import { Message } from "@hexaijs/core";
import { PublicEvent } from "@/index";

@PublicEvent()
export class UserCreated extends Message<{
    userId: string;
}> {}
