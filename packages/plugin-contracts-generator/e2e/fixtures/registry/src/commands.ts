import { Message } from "@hexaijs/core";

import { PublicCommand } from "@/decorators";

@PublicCommand()
export class RegisterUser extends Message<{
    email: string;
    password: string;
}> {
    static type = "user.register";
}

@PublicCommand()
export class PlaceOrder extends Message<{
    productId: string;
    quantity: number;
}> {
    static type = "order.place";
}
