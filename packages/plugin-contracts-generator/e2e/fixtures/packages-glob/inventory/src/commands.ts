import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

import type { ProductId, WarehouseId, Quantity } from "./types";

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
