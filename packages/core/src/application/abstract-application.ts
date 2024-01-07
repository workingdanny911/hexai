import _ from "lodash";
import { C } from "ts-toolbelt";

import {
    isApplicationContextAware,
    isEventPublisherAware,
} from "./inspections";
import { CommonApplicationContext } from "./common-application-context";
import {
    ApplicationEventPublisher,
    ContextOf,
} from "./application-event-publisher";
import { Authenticator, AuthFilter, FactorOf } from "./auth";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";
import {
    authErrorResponse,
    systemErrorResponse,
    validationErrorResponse,
} from "./error-response";
import { AuthError } from "./error";

export abstract class AbstractApplication<
    Ctx extends CommonApplicationContext = CommonApplicationContext,
    Publisher extends ApplicationEventPublisher<
        any,
        any
    > = ApplicationEventPublisher,
    Message extends object = object,
    SecCtx = any,
    Auth extends Authenticator<any, SecCtx> = Authenticator<any, SecCtx>,
> {
    protected authFilters = new Map();
    protected authenticator: Auth | null = null;
    protected authFactor: FactorOf<Auth> | null = null;
    protected securityContext: SecCtx | null = null;

    protected constructor(
        protected context: Ctx,
        protected eventPublisher: Publisher,
        protected handlers: CommandExecutorRegistry<any, Message>
    ) {}

    public withAuthenticator<Factor = any>(
        authenticator: Authenticator<Factor, SecCtx>
    ): AbstractApplication<
        Ctx,
        Publisher,
        Message,
        SecCtx,
        Authenticator<Factor, SecCtx>
    > {
        this.authenticator = authenticator as any;
        return this;
    }

    public withSecurityContext(securityContext: SecCtx) {
        const newApp = this.clone();
        newApp.setSecurityContext(securityContext);
        return newApp;
    }

    protected setSecurityContext(securityContext: SecCtx): void {
        this.securityContext = securityContext;
    }

    public withAuthFactor(authFactor: FactorOf<Auth>) {
        const newApp = this.clone();
        newApp.setAuthFactor(authFactor);
        return newApp;
    }

    protected setAuthFactor(authFactor: FactorOf<Auth>): void {
        this.authFactor = authFactor;
    }

    protected clone(): typeof this {
        return _.clone(this);
    }

    public withHandler<H extends CommandExecutor<Message>>(
        key: string | object | C.Class,
        handler: H,
        config?: { authFilter?: AuthFilter<SecCtx, Message> }
    ): AbstractApplication<Ctx, Publisher, Message> {
        this.handlers.register(key, handler);

        if (config?.authFilter) {
            this.authFilters.set(handler, config.authFilter);
        }

        return this;
    }

    async handle(message: Message): Promise<any> {
        const handler = this.handlers.get(message);
        if (!handler) {
            return validationErrorResponse({
                "*": "UNSUPPORTED_MESSAGE_TYPE",
            });
        }

        try {
            await this.authenticate(message, handler);
        } catch (e) {
            if (e instanceof AuthError) {
                return authErrorResponse(e.message);
            }
        }

        this.injectDependenciesTo(handler);

        return await this.executeHandler(message, handler);
    }

    private async authenticate(
        message: Message,
        handler: CommandExecutor
    ): Promise<void> {
        const authFilter = this.authFilters.get(handler);
        if (!authFilter) {
            return;
        }

        let securityContext: SecCtx | null;
        if (this.authenticator && this.authFactor) {
            securityContext = await this.authenticator(this.authFactor);
        } else {
            securityContext = this.securityContext;
        }

        if (!securityContext) {
            throw new AuthError(
                "authentication failed or no authentication provided"
            );
        }

        await authFilter(securityContext, message);
    }

    protected injectDependenciesTo(handler: CommandExecutor): void {
        if (isApplicationContextAware(handler)) {
            handler.setApplicationContext(this.context);
        }

        if (isEventPublisherAware(handler)) {
            handler.setEventPublisher(this.eventPublisher);
        }
    }

    protected async executeHandler(
        message: Message,
        handler: CommandExecutor
    ): Promise<any> {
        try {
            return await this.eventPublisher.bind(
                this.makeEventContext(message),
                () => handler.execute(message)
            );
        } catch (e) {
            return systemErrorResponse((e as Error).message);
        }
    }

    protected abstract makeEventContext(message: Message): ContextOf<Publisher>;
}
