const SETTLE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 5;

export class ScopeCallbackError extends Error {
    constructor() {
        super("scope callback failed");
        this.name = "ScopeCallbackError";
    }
}

export interface Deferred {
    promise: Promise<void>;
    resolve(): void;
}

export function createDeferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

// Lets every queued promise reaction run, so the code under test reaches its
// next real wait (I/O or a held gate) before the test inspects it.
export function flushPendingWork(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

export async function waitUntil(
    condition: () => boolean,
    description: string
): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

export function captureThrown(fn: () => unknown): unknown {
    try {
        fn();
    } catch (e) {
        return e;
    }
    throw new Error("Expected the operation to throw, but it returned");
}

export async function captureRejection(
    promise: Promise<unknown>
): Promise<unknown> {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    throw new Error("Expected the operation to reject, but it resolved");
}

export async function settleWithin<T>(
    promise: Promise<T>,
    operation: string
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `${operation} did not settle within ${SETTLE_TIMEOUT_MS}ms`
                    )
                ),
            SETTLE_TIMEOUT_MS
        );
    });

    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
