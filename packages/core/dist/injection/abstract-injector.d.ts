export declare abstract class AbstractInjector<O, T extends object> {
    private injectingObject?;
    private targets;
    addCandidate(candidate: unknown): void;
    protected abstract isInjectable(candidate: unknown): candidate is T;
    protected abstract doInject(target: T, injectingObject: O): void;
    inject(): void;
    isInjectingObjectSet(): boolean;
    setInjectingObject(injectingObject: O): void;
}
//# sourceMappingURL=abstract-injector.d.ts.map