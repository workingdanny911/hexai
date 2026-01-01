import { Message } from "@hexaijs/core";
import { PublicCommand } from "@/index";

@PublicCommand()
export class CreateUser extends Message<{
    email: string;
}> {}
