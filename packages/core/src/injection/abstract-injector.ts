export abstract class AbstractInjector<O, T extends object> {
    private injectingObject?: O;
    private targets: Array<T> = [];

    public addCandidate(candidate: unknown): void {
        if (this.targets.includes(candidate as any)) {
            return;
        }

        if (this.isInjectable(candidate)) {
            this.targets.push(candidate);
        }
    }

    protected abstract isInjectable(candidate: unknown): candidate is T;

    protected abstract doInject(target: T, injectingObject: O): void;

    public inject(): void {
        if (this.targets.length === 0) {
            return;
        }

        if (this.injectingObject === undefined) {
            throw new Error(
                "Injecting object is not set. Use 'setInjectingObject' method to set it."
            );
        }

        this.targets.forEach((target) =>
            this.doInject(target, this.injectingObject!)
        );
    }

    public isInjectingObjectSet(): boolean {
        return !!this.injectingObject;
    }

    public setInjectingObject(injectingObject: O): void {
        this.injectingObject = injectingObject;
    }
}
