import type { ProductId, Money, Quantity, CustomerId } from "../shared/types";

export type OrderItem = {
    productId: ProductId;
    quantity: Quantity;
    unitPrice: Money;
};

export type ShippingAddress = {
    street: string;
    city: string;
    country: string;
    postalCode: string;
};

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";

export type Order = {
    customerId: CustomerId;
    items: OrderItem[];
    shippingAddress: ShippingAddress;
    status: OrderStatus;
    totalAmount: Money;
};
