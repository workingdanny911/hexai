export async function importGeneratedModule<T = Record<string, unknown>>(
    modulePath: string
): Promise<T> {
    // Cache busting ensures fresh imports between test runs since modules may be regenerated
    const cacheBuster = `?t=${Date.now()}`;
    return import(modulePath + cacheBuster) as Promise<T>;
}

export async function loadClass<T>(
    modulePath: string,
    className: string
): Promise<new (...args: unknown[]) => T> {
    const module = await importGeneratedModule(modulePath);
    const ClassRef = (module as Record<string, unknown>)[className];

    if (!ClassRef) {
        const availableExports = Object.keys(module as object).join(", ");
        throw new Error(
            `Class "${className}" not found in ${modulePath}. Available exports: ${availableExports}`
        );
    }

    return ClassRef as new (...args: unknown[]) => T;
}

export interface MessageLike {
    getPayload(): Record<string, unknown>;
    validate?(): unknown;
}

export type MessageClass<T extends MessageLike = MessageLike> = new (
    payload: Record<string, unknown>,
    headers?: Record<string, unknown>
) => T;
