import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import type { ProductId, WarehouseId, Quantity } from "./types";

@PublicEvent()
export class StockReceived extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
    receivedAt: number;
}> {}

@PublicEvent()
export class StockReserved extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
    orderId: string;
}> {}
