import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import type { OrderId, OrderStatus } from "./types";

@PublicEvent()
export class OrderCreated extends Message<{
    orderId: OrderId;
    customerId: string;
    createdAt: number;
}> {}

@PublicEvent()
export class OrderStatusChanged extends Message<{
    orderId: OrderId;
    previousStatus: OrderStatus;
    newStatus: OrderStatus;
}> {}
