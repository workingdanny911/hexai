import { CommonApplicationContext } from "@hexai/core";

import {
    AnyMessageHandler,
    InputOf,
    MessageHandlerFunctionFrom,
    MessageHandlerObject,
    OutputOf,
} from "./message-handler";
import { MessageHandlerAware } from "./message-handler-aware";
import { toHandlerFunction } from "./helpers";

export abstract class MessageHandlerTemplate<
        H extends AnyMessageHandler = AnyMessageHandler,
        AC extends CommonApplicationContext = CommonApplicationContext,
    >
    implements
        MessageHandlerObject<InputOf<H>, OutputOf<H>>,
        MessageHandlerAware<H>
{
    protected handler!: MessageHandlerFunctionFrom<H>;
    protected applicationContext!: AC;

    public abstract handle(message: InputOf<H>): Promise<OutputOf<H>>;

    public setMessageHandler(messageHandler: H): void {
        this.handler = toHandlerFunction(messageHandler);
    }

    public setApplicationContext(context: AC): void {
        this.applicationContext = context;
    }
}
