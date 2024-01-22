import {
    ApplicationContextAware,
    ApplicationContextInjector,
    Atomic,
    Message,
    UnitOfWorkHolder,
} from "@hexai/core";

import { IdempotencySupportHolder } from "@/types";
import { MessageHandler, MessageHandlerObject } from "./message-handler";
import { IdempotencySupport } from "./idempotency-support";
import { toHandlerFunction } from "./helpers";

export class IdempotentReceiver<I extends Message, O = unknown>
    implements
        MessageHandlerObject<I, O | void>,
        ApplicationContextAware<UnitOfWorkHolder & IdempotencySupportHolder>
{
    protected support?: IdempotencySupport;
    protected injector = new ApplicationContextInjector();

    constructor(
        private key: string,
        private delegate: MessageHandler<I, O>
    ) {
        this.injector.addCandidate(delegate);
    }

    @Atomic()
    async handle(message: I): Promise<O | void> {
        if (!this.support) {
            throw new Error(
                "idempotent receivers require idempotency support registered " +
                    "in application context,\n" +
                    "but idempotency support not provided"
            );
        }

        if (await this.support.isDuplicate(this.key, message)) {
            return;
        }

        this.injector.inject();
        const result = await toHandlerFunction(this.delegate)(message);
        await this.support.markAsProcessed(this.key, message);
        return result;
    }

    public setApplicationContext(
        applicationContext: UnitOfWorkHolder & IdempotencySupportHolder
    ): void {
        this.support = applicationContext.getIdempotencySupport();
        this.injector.setInjectingObject(applicationContext);
    }
}
