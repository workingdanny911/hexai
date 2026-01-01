export type OrderId = string;

export type OrderItem = {
    productId: string;
    quantity: number;
    unitPrice: number;
};

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
