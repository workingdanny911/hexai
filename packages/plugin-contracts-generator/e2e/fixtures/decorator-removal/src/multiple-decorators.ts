import { PublicCommand } from "@hexaijs/plugin-contracts-generator";
import { Message } from "@hexaijs/core";
import { Injectable } from "@nestjs/common";

@Injectable()
@PublicCommand()
export class ServiceCommand extends Message<{
    data: string;
}> {}
