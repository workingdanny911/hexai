export interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
    reject(reason: unknown): void;
}

export function createDeferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return { promise, resolve, reject };
}

export interface SettlementTracker<T> {
    readonly promise: Promise<T>;
    readonly isSettled: boolean;
}

export function trackSettlement<T>(promise: Promise<T>): SettlementTracker<T> {
    let isSettled = false;
    const markSettled = () => {
        isSettled = true;
    };
    promise.then(markSettled, markSettled);

    return {
        promise,
        get isSettled() {
            return isSettled;
        },
    };
}
