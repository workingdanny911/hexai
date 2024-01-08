import _ from "lodash";
import { C } from "ts-toolbelt";

import { isApplicationContextAware } from "./inspections";
import {
    ApplicationEventPublisher,
    EventContextOf,
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
import { CommonApplicationContext } from "./application-context";

interface ErrorObserver<Message = any> {
    (message: Message, error: Error): void | Promise<void>;
}

interface ApplicationContext extends CommonApplicationContext {
    getEventPublisher(): ApplicationEventPublisher;
    getAuthenticator?(): Authenticator;
}

type EventPublisherOf<C extends ApplicationContext> = ReturnType<
    C["getEventPublisher"]
>;

type AuthenticatorOf<C extends ApplicationContext> =
    C["getAuthenticator"] extends () => Authenticator
        ? ReturnType<C["getAuthenticator"]>
        : never;

export abstract class AbstractApplication<
    Ctx extends ApplicationContext = ApplicationContext,
    Cmd extends object = object,
    SecCtx = any,
> {
    protected authFilters = new Map();
    protected authFactor: any | null = null;
    protected securityContext: SecCtx | null = null;
    protected errorObservers: ErrorObserver[] = [];

    protected constructor(
        protected context: Ctx,
        protected executorRegistry: CommandExecutorRegistry<any, Cmd>
    ) {}

    public withSecurityContext(securityContext: SecCtx) {
        const newApp = this.clone();
        newApp.setSecurityContext(securityContext);
        return newApp;
    }

    protected setSecurityContext(securityContext: SecCtx): void {
        this.securityContext = securityContext;
    }

    public withAuthFactor(authFactor: FactorOf<AuthenticatorOf<Ctx>>) {
        const newApp = this.clone();
        newApp.setAuthFactor(authFactor);
        return newApp;
    }

    protected setAuthFactor(authFactor: FactorOf<AuthenticatorOf<Ctx>>): void {
        this.authFactor = authFactor;
    }

    protected clone(): typeof this {
        return _.clone(this);
    }

    public withExecutor<E extends CommandExecutor<Cmd>>(
        key: string | object | C.Class,
        executor: E,
        config?: { authFilter?: AuthFilter<SecCtx, Cmd> }
    ): AbstractApplication<Ctx, Cmd, SecCtx> {
        this.executorRegistry.register(key, executor);

        if (config?.authFilter) {
            this.authFilters.set(executor, config.authFilter);
        }

        return this;
    }

    async execute(command: Cmd): Promise<any> {
        const executor = this.executorRegistry.get(command);
        if (!executor) {
            return validationErrorResponse({
                "*": "UNSUPPORTED_MESSAGE_TYPE",
            });
        }

        try {
            await this.authenticate(command, executor);
        } catch (e) {
            if (e instanceof AuthError) {
                return authErrorResponse(e.message);
            }
        }

        this.injectApplicationContextTo(executor);

        return await this.doExecute(command, executor);
    }

    private async authenticate(
        command: Cmd,
        handler: CommandExecutor
    ): Promise<void> {
        const authFilter = this.authFilters.get(handler);
        if (!authFilter) {
            return;
        }

        const authenticator = this.context.getAuthenticator?.();
        let securityContext: SecCtx | null;
        if (authenticator && this.authFactor) {
            securityContext = await authenticator(this.authFactor);
        } else {
            securityContext = this.securityContext;
        }

        if (!securityContext) {
            throw new AuthError(
                "authentication failed or no authentication provided"
            );
        }

        await authFilter(securityContext, command);
    }

    protected injectApplicationContextTo(handler: CommandExecutor): void {
        if (isApplicationContextAware(handler)) {
            handler.setApplicationContext(this.context);
        }
    }

    protected async doExecute(
        command: Cmd,
        executor: CommandExecutor
    ): Promise<any> {
        try {
            return await this.context
                .getEventPublisher()
                .bindContext(this.makeEventContext(command), () =>
                    executor.execute(command)
                );
        } catch (e) {
            const error = e as Error;
            this.notifyErrorObservers(command, error);
            return systemErrorResponse((e as Error).message);
        }
    }

    protected abstract makeEventContext(
        command: Cmd
    ): EventContextOf<EventPublisherOf<Ctx>>;

    public onError(observer: ErrorObserver<Cmd>): void {
        this.errorObservers.push(observer);
    }

    protected notifyErrorObservers(command: Cmd, error: Error): void {
        this.errorObservers.forEach((observer) => observer(command, error));
    }
}
