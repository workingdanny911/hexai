import { PublicEvent } from "@hexaijs/plugin-contracts-generator";
import { DomainEvent } from "@hexaijs/core";

@PublicEvent()
export class OrderPlaced extends DomainEvent<{
    orderId: string;
    placedAt: Date;
}> {}
