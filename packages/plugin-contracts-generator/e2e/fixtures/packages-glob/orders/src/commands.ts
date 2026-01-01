import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import type { OrderId, OrderItem } from "./types";

@PublicCommand()
export class CreateOrder extends Message<{
    customerId: string;
    items: OrderItem[];
}> {}

@PublicCommand()
export class CancelOrder extends Message<{
    orderId: OrderId;
    reason: string;
}> {}
