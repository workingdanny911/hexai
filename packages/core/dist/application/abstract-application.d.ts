import { C } from "ts-toolbelt";
import { ApplicationEventPublisher, EventContextOf } from "./application-event-publisher";
import { Authenticator, AuthFilter, FactorOf } from "./auth";
import { CommandExecutorRegistry } from "./command-executor-registry";
import { CommandExecutor } from "./command-executor";
import { CommonApplicationContext } from "./application-context";
interface ErrorObserver<Message = any> {
    (message: Message, error: Error): void | Promise<void>;
}
interface ApplicationContext extends CommonApplicationContext {
    getEventPublisher(): ApplicationEventPublisher;
    getAuthenticator?(): Authenticator;
}
type EventPublisherOf<C extends ApplicationContext> = ReturnType<C["getEventPublisher"]>;
type AuthenticatorOf<C extends ApplicationContext> = C["getAuthenticator"] extends () => Authenticator ? ReturnType<C["getAuthenticator"]> : never;
export declare abstract class AbstractApplication<Ctx extends ApplicationContext = ApplicationContext, Cmd extends object = object, SecCtx = any> {
    protected context: Ctx;
    protected executorRegistry: CommandExecutorRegistry<any, Cmd>;
    protected authFilters: Map<any, any>;
    protected authFactor: any | null;
    protected securityContext: SecCtx | null;
    protected errorObservers: ErrorObserver[];
    protected constructor(context: Ctx, executorRegistry: CommandExecutorRegistry<any, Cmd>);
    withSecurityContext(securityContext: SecCtx): this;
    protected setSecurityContext(securityContext: SecCtx): void;
    withAuthFactor(authFactor: FactorOf<AuthenticatorOf<Ctx>>): this;
    protected setAuthFactor(authFactor: FactorOf<AuthenticatorOf<Ctx>>): void;
    protected clone(): typeof this;
    withExecutor<E extends CommandExecutor<Cmd>>(key: string | object | C.Class, executor: E, config?: {
        authFilter?: AuthFilter<SecCtx, Cmd>;
    }): AbstractApplication<Ctx, Cmd, SecCtx>;
    execute(command: Cmd): Promise<any>;
    private authenticate;
    protected injectApplicationContextTo(handler: CommandExecutor): void;
    protected doExecute(command: Cmd, executor: CommandExecutor): Promise<any>;
    protected abstract makeEventContext(command: Cmd): EventContextOf<EventPublisherOf<Ctx>>;
    onError(observer: ErrorObserver<Cmd>): void;
    protected notifyErrorObservers(command: Cmd, error: Error): void;
}
export {};
//# sourceMappingURL=abstract-application.d.ts.map