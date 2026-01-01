import { PublicCommand } from "@hexaijs/plugin-contracts-generator";
import { Message } from "@hexaijs/core";

@PublicCommand()
export class PlaceOrderCommand extends Message<{
    orderId: string;
    amount: number;
}> {}
