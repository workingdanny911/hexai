import { MessageHandler } from "./message-handler";

export interface MessageHandlerAware<H extends MessageHandler<any, any>> {
    setMessageHandler(messageHandler: H): void;
}
