import { Message } from "@hexaijs/core";

import { PublicEvent } from "@/decorators";

@PublicEvent()
export class UserRegistered extends Message<{
    userId: string;
    email: string;
}> {
    static type = "user.registered";
}

@PublicEvent()
export class UserRegistered_V2 extends Message<{
    userId: string;
    email: string;
    name: string;
}> {
    static type = "user.registered";
    static schemaVersion = 2;
}

@PublicEvent()
export class OrderPlaced extends Message<{
    orderId: string;
    amount: number;
}> {
    static type = "order.placed";
}
