import { Command } from "@hexaijs/application";

export class CreateOrderCommand extends Command<
    { productId: string },
    { role: string }
> {
    constructor(payload: { productId: string }, sc: { role: string }) {
        super(payload, { securityContext: sc });
    }
}
