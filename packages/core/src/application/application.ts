import { F, L } from "ts-toolbelt";

import { ApplicationContextInjector } from "@/injection";
import { TypedEventEmitter, Lifecycle } from "@/utils";
import {
    AnyHandler,
    FindResponseByRequest,
    Handler,
    HandlerObject,
} from "./handler";
import { HandlerRegistry } from "./handler-registry";

export type ContextOf<A> = A extends Application<infer Ctx> ? Ctx : never;

type WithHandler<App, Handler extends AnyHandler> = App extends Application<
    any,
    infer Handlers
>
    ? Application<ContextOf<App>, L.Append<Handlers, Handler>>
    : never;

export class NoHandlerFound extends Error {}

export type ApplicationEventMap = {
    started: [];
    stopped: [];
};

export interface ApplicationExtension<
    Mthds extends Record<string, F.Function>,
    App extends Application = Application,
> {
    extend(app: App): Mthds;
}

type ExtensionMethodsOf<Ext> = Ext extends ApplicationExtension<
    infer Mthds,
    any
>
    ? Mthds
    : never;

class Companions {
    private registry: Array<[string | symbol, Lifecycle]> = [];

    public register(name: string | symbol, companion: Lifecycle) {
        this.registry = [
            ...this.registry.filter(([n]) => n !== name),
            [name, companion],
        ];
    }

    public async startAll() {
        await Promise.all(this.registry.map(([, c]) => c.start()));
    }

    public async stopAll() {
        await Promise.all(this.registry.map(([, c]) => c.stop()));
    }
}

export class Application<
        Ctx extends object = any,
        Handlers extends L.List<AnyHandler> = [],
        EventMap extends ApplicationEventMap = ApplicationEventMap,
    >
    extends TypedEventEmitter<EventMap>
    implements Lifecycle, HandlerObject
{
    protected ctxInjector = new ApplicationContextInjector<Ctx>();
    protected companions = new Companions();
    protected _isRunning = false;

    constructor(
        public readonly context: Ctx,
        protected handlers: HandlerRegistry
    ) {
        super();

        this.ctxInjector.setInjectingObject(context);
    }

    public registerCompanion(
        name: string | symbol,
        companion: Lifecycle
    ): this {
        this.companions.register(name, companion);
        return this;
    }

    public isRunning() {
        return this._isRunning;
    }

    public async start(): Promise<void> {
        this.ctxInjector.inject();

        await this.companions.startAll();

        this.started();
    }

    protected started() {
        this.emit("started");

        this._isRunning = true;

        return this;
    }

    public async stop(): Promise<void> {
        await this.companions.stopAll();

        this.stopped();
    }

    protected stopped() {
        this.emit("stopped");

        this._isRunning = false;
    }

    public withHandler<Handler extends AnyHandler>(
        key: any,
        handler: Handler
    ): WithHandler<Application<Ctx, Handlers>, Handler> {
        this.ctxInjector.addCandidate(handler);
        this.handlers.register(key, handler);

        return this as any;
    }

    async handle<M>(request: M): Promise<FindResponseByRequest<Handlers, M>> {
        if (!this.isRunning()) {
            throw new Error(
                "Cannot handle requests when application is not running"
            );
        }

        const handler = this.handlers.getByRequest(request);

        if (!handler) {
            throw new NoHandlerFound(
                `No handler found for request: ${JSON.stringify(request)}`
            );
        }

        return await this.doHandle(request, handler);
    }

    protected async doHandle(request: any, handler: Handler): Promise<any> {
        if (typeof handler === "function") {
            return handler(request);
        } else {
            return handler.handle(request);
        }
    }

    public install<Ext extends ApplicationExtension<any, this>>(
        extension: Ext
    ): this & ExtensionMethodsOf<Ext> {
        const extensionMethods = extension.extend(this);

        for (const [name, method] of Object.entries(extensionMethods)) {
            (this as any)[name] = method;
        }

        return this as any;
    }
}
