import { F, L } from "ts-toolbelt";

import { ApplicationContextInjector } from "@/injection";
import { EventEmitter, Lifecycle } from "@/utils";
import {
    AnyMessageHandler,
    FindResultByMessage,
    MessageHandler,
    MessageHandlerObject,
} from "./message-handler";
import { MessageHandlerRegistry } from "./message-handler-registry";

export type ContextOf<A> = A extends Application<infer Ctx> ? Ctx : never;

type WithMessageHandler<
    App,
    Handler extends AnyMessageHandler,
> = App extends Application<any, infer Handlers>
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
        Handlers extends L.List<AnyMessageHandler> = [],
        EventMap extends ApplicationEventMap = ApplicationEventMap,
    >
    extends EventEmitter<EventMap>
    implements Lifecycle, MessageHandlerObject
{
    protected ctxInjector = new ApplicationContextInjector<Ctx>();
    protected companions = new Companions();
    protected _isRunning = false;

    constructor(
        public readonly context: Ctx,
        protected handlers: MessageHandlerRegistry
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

    public withMessageHandler<Handler extends AnyMessageHandler>(
        key: any,
        handler: Handler
    ): WithMessageHandler<Application<Ctx, Handlers>, Handler> {
        this.ctxInjector.addCandidate(handler);
        this.handlers.register(key, handler);

        return this as any;
    }

    async handle<M>(message: M): Promise<FindResultByMessage<Handlers, M>> {
        if (!this.isRunning()) {
            throw new Error(
                "Cannot handle messages when application is not running"
            );
        }

        const handler = this.handlers.getByMessage(message);

        if (!handler) {
            throw new NoHandlerFound(
                `No handler found for message: ${JSON.stringify(message)}`
            );
        }

        return await this.doHandle(message, handler);
    }

    protected async doHandle(
        message: any,
        handler: MessageHandler
    ): Promise<any> {
        if (typeof handler === "function") {
            return handler(message);
        } else {
            return handler.handle(message);
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
