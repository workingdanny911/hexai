import { Message } from "@hexaijs/core";

import { PublicQuery } from "@/decorators";

@PublicQuery()
export class GetUserById extends Message<{
    userId: string;
}> {
    static type = "user.get-by-id";
}

@PublicQuery()
export class GetOrderHistory extends Message<{
    userId: string;
    limit?: number;
}> {
    static type = "order.get-history";
}
