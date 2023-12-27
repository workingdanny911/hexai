import { C, L } from "ts-toolbelt";

import { ConsumedEventTracker } from "@/infra";
import { Factory, isClass, ObjectRegistry } from "@/utils";
import { Event } from "@/message";

import { BaseApplicationContext } from "./base-application-context";
import { ApplicationImpl } from "./application-impl";
import { UseCaseFactory } from "./common-types";
import { EventHandler, EventHandlerMeta } from "./event-handler";
import { Authenticator, AuthFilter } from "./auth";
import { Application, AuthPrincipalOf } from "./application";

type WithUseCase<UseCase, App> = App extends ApplicationBuilder<
    infer Ctx,
    infer Cmds,
    infer Events,
    infer Auth
>
    ? ApplicationBuilder<
          Ctx,
          L.Append<
              Cmds,
              UseCase extends UseCaseFactory<Ctx, infer Req, infer Res>
                  ? [Req, Res]
                  : never
          >,
          Events,
          Auth
      >
    : never;

type ReqTypeOfUCFactory<T> = T extends UseCaseFactory<any, infer Req>
    ? Req
    : never;

export class ApplicationBuilder<
    Ctx extends BaseApplicationContext = any,
    Cmds extends L.List = [],
    Events extends Event = never,
    AuthPrincipal = any,
> {
    private context!: Ctx;
    private applicationClass: any = ApplicationImpl;
    private useCaseFactories = new ObjectRegistry();
    private eventHandlerFactories = new ObjectRegistry();
    private authFilters = new ObjectRegistry();
    private consumedEventTracker?: ConsumedEventTracker;
    private authenticator?: Authenticator<any, AuthPrincipal>;

    public withApplicationClass(
        applicationClass: unknown
    ): ApplicationBuilder<Ctx, Cmds, Events, AuthPrincipal> {
        this.applicationClass = applicationClass;
        return this as any;
    }

    public withContext<T extends Ctx>(
        context: T
    ): ApplicationBuilder<T, Cmds, Events, AuthPrincipal> {
        this.context = context;
        return this as any;
    }

    public withAuthenticator<T extends Authenticator>(
        authenticator: T
    ): ApplicationBuilder<Ctx, Cmds, Events, AuthPrincipalOf<T>> {
        (this as any).authenticator = authenticator;
        return this as any;
    }

    public withUseCase<T extends UseCaseFactory<Ctx>>(
        requestClass: C.Class<any[], ReqTypeOfUCFactory<T>>,
        useCaseFactory: T,
        authFilter?: AuthFilter<AuthPrincipal, ReqTypeOfUCFactory<T>>
    ): WithUseCase<T, ApplicationBuilder<Ctx, Cmds, Events, AuthPrincipal>> {
        if (!isClass(requestClass)) {
            throw new Error(`parameter 'requestClass' must be a class.`);
        }

        if (this.useCaseFactories.isRegistered(requestClass)) {
            throw new Error(
                `use case for '${requestClass}' is already registered.`
            );
        }

        if (authFilter) {
            this.authFilters.register(requestClass, authFilter);
        }

        this.useCaseFactories.register(requestClass, useCaseFactory);

        return this as any;
    }

    public withConsumedEventTracker(
        tracker: ConsumedEventTracker
    ): ApplicationBuilder<Ctx, Cmds, Events> {
        this.consumedEventTracker = tracker;
        return this as any;
    }

    public withEventHandler<E extends Event>(
        name: string,
        eventHandlerFactory: Factory<[Ctx], EventHandler<E>>
    ): ApplicationBuilder<Ctx, Cmds, Events | E>;

    public withEventHandler<E extends Event>(
        eventHandlerFactory: Factory<[Ctx], EventHandler<E>>
    ): ApplicationBuilder<Ctx, Cmds, Events | E>;

    public withEventHandler<E extends Event>(
        nameOrFactory: string | Factory<[Ctx], EventHandler<E>>,
        factory?: Factory<[Ctx], EventHandler<E>>
    ): ApplicationBuilder<Ctx, Cmds, Events | E> {
        let meta: EventHandlerMeta;

        if (typeof nameOrFactory === "string") {
            const name = nameOrFactory;
            if (this.hasEventHandlerWithName(name)) {
                throw new Error(
                    `event handler with name '${name}' is already registered.`
                );
            }

            meta = this.makeEventHandlerMeta(name);
        } else {
            meta = this.makeEventHandlerMeta();
            factory = nameOrFactory;
        }

        this.eventHandlerFactories.register(meta, factory as any);

        return this as any;
    }

    public withIdempotentEventHandler<E extends Event>(
        name: string,
        eventHandlerFactory: Factory<[Ctx], EventHandler<E>>
    ): ApplicationBuilder<Ctx, Cmds, Events | E> {
        if (this.hasEventHandlerWithName(name)) {
            throw new Error(
                `idempotent event handler with name '${name}' is already registered.`
            );
        }

        this.eventHandlerFactories.register(
            this.makeEventHandlerMeta(name, true),
            eventHandlerFactory
        );

        return this as any;
    }

    private makeEventHandlerMeta(
        name?: string,
        idempotent = false
    ): EventHandlerMeta {
        const index = this.eventHandlerFactories.size();
        return { index, name: name ?? `anonymous-${index}`, idempotent };
    }

    private hasEventHandlerWithName(name: string): boolean {
        return [...this.eventHandlerFactories.keys()].some(
            (meta) => meta.name === name
        );
    }

    public build(): Application<Ctx, Cmds, Events, AuthPrincipal> {
        if (!this.context) {
            throw new Error(
                "application context must be provided. \n" +
                    "use 'withContext()' to provide application context."
            );
        }

        if (this.hasIdempotentEventHandler() && !this.consumedEventTracker) {
            throw new Error(
                "consumed event tracker must be provided in order to register idempotent event handlers.\n" +
                    "use 'withConsumedEventTracker()' to provide event tracker."
            );
        }

        return new this.applicationClass(
            this.context,
            this.useCaseFactories,
            this.eventHandlerFactories,
            this.consumedEventTracker,
            this.authFilters,
            this.authenticator
        );
    }

    private hasIdempotentEventHandler(): boolean {
        return [...this.eventHandlerFactories.keys()].some(
            (meta) => meta.idempotent
        );
    }
}
