import { v4 as uuid } from "uuid";

type Version = string | number | undefined;

interface CommonMessageHeaders {
    id: string;
    type: string;
    schemaVersion?: Version;
    createdAt: Date;
}

export interface MessageHeaders extends CommonMessageHeaders {
    [key: string]: unknown;
}

type ExtraHeaderField = Exclude<
    keyof MessageHeaders,
    keyof CommonMessageHeaders
>;

export class Message<T extends Record<string, any> = Record<string, unknown>> {
    protected headers!: MessageHeaders;

    public static getSchemaVersion(): Version {
        return (this as any).schemaVersion ?? undefined;
    }

    public static getType(): string {
        return (this as any).type ?? this.name;
    }

    protected static newHeaders(): MessageHeaders {
        return generateHeaderFor(this as any);
    }

    public static from(
        rawPayload: Record<string, unknown>,
        headers?: MessageHeaders
    ): Message {
        const payload = this.deserializeRawPayload(rawPayload);
        return new this(payload, this.deserializeRawHeaders(headers));
    }

    protected static deserializeRawPayload(rawPayload: any): any {
        return rawPayload;
    }

    protected static deserializeRawHeaders(
        headers?: MessageHeaders
    ): MessageHeaders {
        if (!headers) {
            return this.newHeaders();
        }

        return {
            ...headers,
            createdAt: new Date(headers.createdAt),
        };
    }

    constructor(
        protected readonly payload: T,
        headers?: MessageHeaders
    ) {
        this.headers = headers ?? (this.constructor as any).newHeaders();
    }

    public setHeader(field: ExtraHeaderField, value: unknown): void {
        this.headers[field] = value;
    }

    public getHeader<T = string>(field: string): T | undefined {
        return this.headers[field] as any;
    }

    public getPayload(): T {
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

    public serialize(): {
        headers: MessageHeaders;
        payload: Record<string, unknown>;
    } {
        return {
            headers: { ...this.headers },
            payload: this.serializePayload(this.payload),
        };
    }

    protected serializePayload(payload: T): Record<string, unknown> {
        return payload;
    }

    public asType<M extends MessageClass>(cls: M): InstanceType<M> {
        const { headers, payload } = this.serialize();
        return cls.from(payload, headers) as InstanceType<M>;
    }
}

export type AnyMessage = Message<any>;

export type MessageClass<T extends AnyMessage = AnyMessage> = {
    getSchemaVersion(): Version;
    getType(): string;
    from: (rawPayload: any, header?: MessageHeaders) => T;
    new (...args: any[]): T;
};

function generateHeaderFor(cls: MessageClass): MessageHeaders {
    const headers: MessageHeaders = {
        id: uuid(),
        type: cls.getType(),
        createdAt: new Date(),
    };

    const schemaVersion = cls.getSchemaVersion();
    if (schemaVersion !== undefined) {
        headers.schemaVersion = schemaVersion;
    }

    return headers;
}
