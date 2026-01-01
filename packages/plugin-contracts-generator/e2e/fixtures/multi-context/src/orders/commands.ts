import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import type { OrderId, CustomerId } from "../shared/types";
import type { OrderItem, ShippingAddress } from "./types";

@PublicCommand()
export class CreateOrder extends Message<{
    customerId: CustomerId;
    items: OrderItem[];
    shippingAddress: ShippingAddress;
}> {}

@PublicCommand()
export class CancelOrder extends Message<{
    orderId: OrderId;
    reason: string;
}> {}
