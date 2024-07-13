import { MessageHandler } from "@/application/message-handler";

export class SimpleMessageHandlerRegistry {
    private handlers: Record<string, MessageHandler> = {};

    register(messageType: string, handler: MessageHandler) {
        this.handlers[messageType] = handler;
    }

    getByMessage(message: any) {
        return this.handlers[message.type];
    }
}
