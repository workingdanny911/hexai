export interface Injector<O = unknown, S extends object = object> {
    canInjectTo(target: unknown): boolean;

    injectTo(target: O): void;

    setInjectingObject(injectingObject: S): void;
}
