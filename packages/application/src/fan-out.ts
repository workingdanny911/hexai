/**
 * Invokes items concurrently, like `Promise.all(items.map(invoke))`, but
 * settles only after every started invocation has settled. It then rejects
 * with the first failure observed, if any. A synchronous throw is observed
 * immediately and stops later items from being invoked, as with
 * `Promise.all` over `map`.
 *
 * Event fan-out usually runs inside a unit-of-work scope. Settling on the
 * first failure, as `Promise.all` does, lets that scope end while sibling
 * handlers are still running, so their later work escapes the transaction.
 */
export async function fanOut<T>(
    items: Iterable<T>,
    invoke: (item: T) => unknown
): Promise<void> {
    // Wrapped so that a thrown `undefined` still counts as a failure.
    let failure: { error: unknown } | undefined;
    const recordFailure = (error: unknown) => {
        failure ??= { error };
    };
    const running: Promise<void>[] = [];

    for (const item of items) {
        let outcome: unknown;
        try {
            outcome = invoke(item);
        } catch (error) {
            recordFailure(error);
            break;
        }
        running.push(
            Promise.resolve(outcome).then(() => undefined, recordFailure)
        );
    }

    await Promise.all(running);

    if (failure) {
        throw failure.error;
    }
}
