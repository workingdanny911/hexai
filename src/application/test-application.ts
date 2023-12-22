import { L } from "ts-toolbelt";

import { Command, Event } from "Hexai/message";
import { BaseApplicationContext } from "./base-application-context";
import { Authenticator } from "./auth";
import { ApplicationImpl } from "./application-impl";
import { FindResponseType, IfSupports } from "./application";
import { ErrorResponse } from "./error-response";

export class TestApplication<
    Ctx extends BaseApplicationContext,
    Cmds extends L.List,
    Events extends Event,
    AuthPrincipal = any,
    TAuthenticator extends Authenticator = Authenticator<any, AuthPrincipal>,
> extends ApplicationImpl<Ctx, Cmds, Events, AuthPrincipal, TAuthenticator> {
    public async execute<I extends Command>(
        request: IfSupports<Cmds, I>
    ): Promise<FindResponseType<Cmds, I> | ErrorResponse> {
        return await this.context
            .getUnitOfWork()
            .wrap(() => super.execute(request));
    }

    public async handle(event: Events): Promise<void> {
        return await this.context
            .getUnitOfWork()
            .wrap(() => super.handle(event));
    }

    protected async handleEventsInternally(events: Events[]): Promise<void> {
        await Promise.all(events.map((event) => this.handle(event)));
    }
}
