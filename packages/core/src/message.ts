import { v4 as uuid } from "uuid";

type Version = string | number | undefined;

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
        return new this(
            payload,
            headers ? this.deserializeRawHeaders(headers) : this.newHeaders()
        );
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
        headers: Record<string, unknown> = {}
    ) {
        this.headers = Object.freeze(
            (this.constructor as any).mergeHeaders(headers)
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
        return new (this.constructor as any)(this.payload, newHeaders);
    }

    protected clone(): this {
        return new (this.constructor as any)(this.payload, { ...this.headers });
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

    public serialize(): {
        headers: MessageHeaders;
        payload: Record<string, unknown>;
    } {
        // we do this to convert the Date object to a string
        // and also to remove any reference to the original object
        return JSON.parse(JSON.stringify(this.doSerialize()));
    }

    private doSerialize(): {
        headers: MessageHeaders;
        payload: unknown;
    } {
        return {
            headers: { ...this.headers },
            payload: this.serializePayload(this.payload),
        };
    }

    protected serializePayload(payload: Payload): unknown {
        return payload;
    }

    public asType<M extends MessageClass>(cls: M): InstanceType<M> {
        const { headers, payload } = this.serialize();
        return cls.from(payload, headers) as InstanceType<M>;
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
