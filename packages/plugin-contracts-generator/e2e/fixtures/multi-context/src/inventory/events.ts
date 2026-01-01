import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

import type { ProductId, Timestamp, Quantity } from "../shared/types";
import type { WarehouseId, StockAdjustmentReason } from "./types";

@PublicEvent()
export class StockReceived extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
    receivedAt: Timestamp;
}> {}

@PublicEvent()
export class StockReserved extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
    orderId: string;
    reservedAt: Timestamp;
}> {}

@PublicEvent()
export class StockAdjusted extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    adjustment: Quantity;
    reason: StockAdjustmentReason;
    adjustedAt: Timestamp;
}> {}
