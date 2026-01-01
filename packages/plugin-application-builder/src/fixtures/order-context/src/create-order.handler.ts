import { CommandHandlerMarker } from "@hexaijs/plugin-application-builder";
import { CreateOrderCommand } from "./create-order.command";

@CommandHandlerMarker(CreateOrderCommand)
export class CreateOrderHandler {
    async execute(command: CreateOrderCommand): Promise<{ orderId: string }> {
        return { orderId: "456" };
    }
}
