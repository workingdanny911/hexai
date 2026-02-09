import { v4 as uuid } from "uuid";

type Version = string | number | undefined;

export interface MessageTrace {
    id: string;
    type: string;
}

export interface MessageHeaders {
    id: string;
    type: string;
    intent?: string;
    schemaVersion?: Version;
    createdAt: Date;

    [key: string]: unknown;
}

type ExtraHeaderField = Exclude<
    keyof MessageHeaders,
    "id" | "type" | "intent" | "schemaVersion" | "createdAt"
>;

type RawMessageHeaders = Omit<MessageHeaders, "createdAt"> & {
    createdAt: string | Date;
};

export interface MessageOptions {
    headers?: Record<string, unknown>;
}

export class Message<Payload = any> {
    protected headers!: MessageHeaders;

    public static getSchemaVersion(): Version {
        return (this as any).schemaVersion ?? undefined;
    }

    public static getType(): string {
        return (this as any).type ?? this.name;
    }

    public static getIntent(): string | undefined {
        return (this as any).intent ?? undefined;
    }

    protected static newHeaders(...excludes: string[]): MessageHeaders {
        return generateHeaderFor(this as any, ...excludes);
    }

    public static from(
        rawPayload: Record<string, unknown>,
        headers?: RawMessageHeaders
    ): Message {
        const payload = this.deserializeRawPayload(rawPayload);
        return new this(payload, {
            headers: headers
                ? this.deserializeRawHeaders(headers)
                : this.newHeaders(),
        });
    }

    protected static deserializeRawPayload(rawPayload: any): any {
        return rawPayload;
    }

    protected static deserializeRawHeaders(
        headers: RawMessageHeaders
    ): MessageHeaders {
        headers.createdAt = new Date(headers.createdAt);

        return headers as MessageHeaders;
    }

    constructor(
        protected readonly payload: Payload,
        options?: MessageOptions
    ) {
        this.headers = Object.freeze(
            (this.constructor as any).mergeHeaders(options?.headers ?? {})
        );

        if (payload && typeof payload === "object") {
            Object.freeze(payload);
        }
    }

    protected static mergeHeaders(
        headers: Record<string, unknown>
    ): MessageHeaders {
        return {
            ...this.newHeaders(...Object.keys(headers)),
            ...headers,
        };
    }

    public withHeader(field: ExtraHeaderField, value: unknown): this {
        const newHeaders = { ...this.headers, [field]: value };
        return this.cloneWithHeaders(newHeaders);
    }

    protected clone(): this {
        const cloned = Object.create(Object.getPrototypeOf(this));
        Object.assign(cloned, this);
        return cloned;
    }

    protected cloneWithHeaders(headers: Record<string, unknown>): this {
        const cloned = this.clone();
        Object.defineProperty(cloned, "headers", {
            value: Object.freeze(headers),
            writable: false,
            configurable: true,
        });
        return cloned;
    }

    public getHeader<T = string>(field: string): T | undefined {
        return this.headers[field] as any;
    }

    public getHeaders(): MessageHeaders {
        return Object.freeze({ ...this.headers });
    }

    public getPayload(): Payload {
        return this.payload;
    }

    public getMessageId(): string {
        return this.headers.id;
    }

    public getMessageType(): string {
        return this.headers.type;
    }

    public getSchemaVersion(): Version | undefined {
        return this.headers.schemaVersion;
    }

    public getTimestamp(): Date {
        return this.headers.createdAt;
    }

    public getIntent(): string | undefined {
        return (this.constructor as MessageClass).getIntent();
    }

    public toJSON(): {
        headers: MessageHeaders;
        payload: unknown;
    } {
        return {
            headers: { ...this.headers },
            payload: this.serializePayload(this.payload),
        };
    }

    public serialize(): {
        headers: MessageHeaders;
        payload: Record<string, unknown>;
    } {
        return JSON.parse(JSON.stringify(this.toJSON()));
    }

    protected serializePayload(payload: Payload): unknown {
        return payload;
    }

    public asType<M extends MessageClass>(cls: M): InstanceType<M> {
        const { headers, payload } = this.serialize();
        return cls.from(payload, headers) as InstanceType<M>;
    }

    public asTrace(): MessageTrace {
        return { id: this.getMessageId(), type: this.getMessageType() };
    }

    public getCausation(): MessageTrace | undefined {
        return this.getHeader<MessageTrace>("causation");
    }

    public getCorrelation(): MessageTrace | undefined {
        return this.getHeader<MessageTrace>("correlation");
    }

    public withCausation(trace: MessageTrace): this {
        return this.withHeader("causation", trace);
    }

    public withCorrelation(trace: MessageTrace): this {
        return this.withHeader("correlation", trace);
    }
}

export type AnyMessage = Message;

export type MessageClass<T extends Message = Message> = {
    getSchemaVersion(): Version;
    getType(): string;
    getIntent(): string | undefined;
    from: (rawPayload: any, header?: MessageHeaders) => T;
    new (...args: any[]): T;
};

function generateHeaderFor(
    cls: MessageClass,
    ...excludes: string[]
): MessageHeaders {
    const headers: Partial<MessageHeaders> = {};

    if (!excludes.includes("id")) {
        headers.id = uuid();
    }

    if (!excludes.includes("type")) {
        headers.type = cls.getType();
    }

    if (!excludes.includes("intent")) {
        const intent = cls.getIntent();
        if (intent !== undefined) {
            headers.intent = intent;
        }
    }

    if (!excludes.includes("schemaVersion")) {
        const schemaVersion = cls.getSchemaVersion();
        if (schemaVersion !== undefined) {
            headers.schemaVersion = schemaVersion;
        }
    }

    if (!excludes.includes("createdAt")) {
        headers.createdAt = new Date();
    }

    return headers as MessageHeaders;
}

export type PayloadOf<M> = M extends Message<infer P> ? P : never;
