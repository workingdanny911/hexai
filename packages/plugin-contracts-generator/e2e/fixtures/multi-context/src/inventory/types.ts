import type { ProductId, Quantity } from "../shared/types";

export type WarehouseId = string;

export type StockLevel = {
    productId: ProductId;
    warehouseId: WarehouseId;
    available: Quantity;
    reserved: Quantity;
};

export type StockAdjustmentReason = "received" | "sold" | "damaged" | "returned" | "audit";
