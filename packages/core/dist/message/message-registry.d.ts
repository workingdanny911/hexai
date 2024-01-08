import { AnyMessage, MessageClass, MessageHeaders } from "./message";
export declare class MessageRegistry {
    private readonly registry;
    register(messageClass: MessageClass): void;
    dehydrate<T extends AnyMessage = AnyMessage>(header: MessageHeaders, body: Record<string, unknown>): T;
}
//# sourceMappingURL=message-registry.d.ts.map