type Version = string | number | undefined;

export interface MessageHeaders {
    id: string;
    type: string;
    schemaVersion?: Version;
    createdAt: Date;
    [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface MessageClass<T = any> {
    getSchemaVersion(): Version;
    getType(): string;
    from(rawPayload: Record<string, unknown>, header?: MessageHeaders): T;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (payload: any, options?: any): T;
}

export class MessageRegistry {
    private readonly registry = new Map<string, MessageClass>();

    register(messageClass: MessageClass): this {
        const type = messageClass.getType();
        const version = messageClass.getSchemaVersion();
        const key = makeKey(type, version);

        if (this.registry.has(key)) {
            throw new Error(`${format(type, version)} is already registered.`);
        }

        this.registry.set(key, messageClass);
        return this;
    }

    dehydrate<T>(header: MessageHeaders, body: Record<string, unknown>): T {
        const { type, schemaVersion } = header;
        const key = makeKey(type, schemaVersion);
        const messageClass = this.registry.get(key);

        if (!messageClass) {
            throw new Error(`${format(type, schemaVersion)} is not registered.`);
        }

        return messageClass.from(body, header) as T;
    }

    has(type: string, version?: Version): boolean {
        return this.registry.has(makeKey(type, version));
    }

    size(): number {
        return this.registry.size;
    }
}

function makeKey(type: string, version?: Version): string {
    return version !== undefined ? `${type}:${version}` : type;
}

function format(type: string, version?: Version): string {
    return version !== undefined ? `'${type}' (v${version})` : `'${type}'`;
}
