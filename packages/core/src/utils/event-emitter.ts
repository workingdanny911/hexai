import UntypedEventEmitter from "node:events";

type EnsureKey<K> = K extends string | symbol ? K : never;

// don't know why typescript compiler is complaining about
// listener type as (this: this, ...args: EventMap[K]) => void,
// so I had to use any type for listener
type AnyListener = (...args: any[]) => void;

export class EventEmitter<
    EventMap extends Record<string | symbol, any[]> = Record<string, any>,
> {
    private emitter = new UntypedEventEmitter();

    public on<K extends keyof EventMap>(
        event: EnsureKey<K>,
        listener: (this: this, ...args: EventMap[K]) => void
    ): this {
        this.emitter.on(event, listener.bind(this) as AnyListener);
        return this;
    }

    public once<K extends keyof EventMap>(
        event: EnsureKey<K>,
        listener: (this: this, ...args: EventMap[K]) => void
    ): this {
        this.emitter.once(event, listener.bind(this) as AnyListener);
        return this;
    }

    public off<K extends keyof EventMap>(
        event: EnsureKey<K>,
        listener: (this: this, ...args: EventMap[K]) => void
    ): this {
        this.emitter.off(event, listener.bind(this) as AnyListener);
        return this;
    }

    public emit<K extends keyof EventMap>(
        event: EnsureKey<K>,
        ...args: EventMap[K]
    ): boolean {
        return this.emitter.emit(event, ...args);
    }
}
