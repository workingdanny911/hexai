import { MessageWithAuth } from "@/message-with-auth";

export class Command<
    Payload = unknown,
    ResultType = unknown,
    SecCtx = unknown,
> extends MessageWithAuth<Payload, ResultType, SecCtx> {
    static override getIntent(): string {
        return "command";
    }
}
