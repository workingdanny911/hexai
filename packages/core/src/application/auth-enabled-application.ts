import { C } from "ts-toolbelt";

import { UnitOfWork } from "@/infra";
import { Authenticator, AuthFilter, FactorOf } from "./auth";
import { CommandExecutor } from "./command-executor";
import { AuthError } from "./error";
import { authErrorResponse } from "./error-response";
import { ApplicationEventPublisher } from "./application-event-publisher";
import { CommonApplicationContext } from "./application-context";
import { AbstractApplication } from "./abstract-application";

export interface AuthEnabledApplicationContext<
    UoW extends UnitOfWork = UnitOfWork,
    EPub extends ApplicationEventPublisher = ApplicationEventPublisher,
    Auth extends Authenticator = Authenticator,
> extends CommonApplicationContext<UoW, EPub> {
    getAuthenticator?: () => Auth;
}

type AuthenticatorOf<C> = C extends AuthEnabledApplicationContext<
    any,
    any,
    infer A
>
    ? A
    : never;

type SecurityContextOf<C extends AuthEnabledApplicationContext> =
    C["getAuthenticator"] extends () => infer A
        ? A extends Authenticator<infer S, any>
            ? S
            : never
        : any;

export abstract class AuthEnabledApplication<
    Ctx extends AuthEnabledApplicationContext,
    Cmd extends object = object,
    SecCtx = SecurityContextOf<Ctx>,
> extends AbstractApplication<Ctx, Cmd> {
    protected authFilters = new Map();
    protected authFactor: any | null = null;
    protected securityContext: SecCtx | null = null;

    public withSecurityContext(
        securityContext: SecCtx
    ): AuthEnabledApplication<Ctx, Cmd, SecCtx> {
        const newApp = this.clone();
        newApp.setSecurityContext(securityContext);
        return newApp;
    }

    protected setSecurityContext(securityContext: SecCtx): void {
        this.securityContext = securityContext;
    }

    public withAuthFactor(
        authFactor: FactorOf<AuthenticatorOf<Ctx>>
    ): AuthEnabledApplication<Ctx, Cmd, SecCtx> {
        const newApp = this.clone();
        newApp.setAuthFactor(authFactor);
        return newApp;
    }

    protected setAuthFactor(authFactor: FactorOf<AuthenticatorOf<Ctx>>): void {
        this.authFactor = authFactor;
    }

    public override withExecutor<E extends CommandExecutor<Cmd>>(
        key: string | object | C.Class,
        executor: E,
        config?: { authFilter?: AuthFilter<SecCtx, Cmd> }
    ): AuthEnabledApplication<Ctx, Cmd, SecCtx> {
        super.withExecutor(key, executor);

        if (config?.authFilter) {
            this.authFilters.set(executor, config.authFilter);
        }

        return this;
    }

    public override async execute(command: Cmd): Promise<any> {
        try {
            return await super.execute(command);
        } catch (e) {
            if (e instanceof AuthError) {
                return authErrorResponse(e.message);
            }

            throw e;
        }
    }

    protected override async beforeExecute(
        executor: CommandExecutor,
        command: Cmd
    ): Promise<void> {
        super.beforeExecute(executor, command);
        await this.authenticate(command, executor);
    }

    protected async authenticate(
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
}
