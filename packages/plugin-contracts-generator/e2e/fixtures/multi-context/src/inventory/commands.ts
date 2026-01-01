import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import type { ProductId, Quantity } from "../shared/types";
import type { WarehouseId, StockAdjustmentReason } from "./types";

@PublicCommand()
export class ReceiveStock extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
}> {}

@PublicCommand()
export class ReserveStock extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    quantity: Quantity;
    orderId: string;
}> {}

@PublicCommand()
export class AdjustStock extends Message<{
    productId: ProductId;
    warehouseId: WarehouseId;
    adjustment: Quantity;
    reason: StockAdjustmentReason;
}> {}
