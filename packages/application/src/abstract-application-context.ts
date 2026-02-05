import lodash from "lodash";
import { Message } from "@hexaijs/core";

import { ApplicationEventPublisher } from "./application-event-publisher";

export abstract class AbstractApplicationContext {
    protected eventPublisher: ApplicationEventPublisher;

    constructor(eventPublisher?: ApplicationEventPublisher) {
        this.eventPublisher = eventPublisher ?? new ApplicationEventPublisher();
    }

    public setEventPublisher(eventPublisher: ApplicationEventPublisher): void {
        this.eventPublisher = eventPublisher;
    }

    protected clone(): this {
        return lodash.clone(this);
    }

    public async enterCommandExecutionScope<C extends Message>(
        command: C,
        fn: (ctx: this) => Promise<void>
    ): Promise<void> {
        const newContext: this = this.clone();

        await newContext.onEnter(command);

        await fn(newContext);

        await newContext.onExit(command);
    }

    public async publish(...events: Message[]): Promise<void> {
        await this.eventPublisher.publish(...events);
    }

    protected async onEnter(message: Message): Promise<void> {
        this.eventPublisher = this.eventPublisher.deriveFrom(message);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected async onExit(message: Message): Promise<void> {
        return;
    }
}
