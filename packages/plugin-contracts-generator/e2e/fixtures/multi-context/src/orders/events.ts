import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import type { OrderId, CustomerId, Timestamp } from "../shared/types";
import type { OrderItem, OrderStatus } from "./types";

@PublicEvent()
export class OrderCreated extends Message<{
    orderId: OrderId;
    customerId: CustomerId;
    items: OrderItem[];
    createdAt: Timestamp;
}> {}

@PublicEvent()
export class OrderStatusChanged extends Message<{
    orderId: OrderId;
    previousStatus: OrderStatus;
    newStatus: OrderStatus;
    changedAt: Timestamp;
}> {}

@PublicEvent()
export class OrderCancelled extends Message<{
    orderId: OrderId;
    reason: string;
    cancelledAt: Timestamp;
}> {}
