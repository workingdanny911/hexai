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

type KnownHeaderOrUnknown<T> = T extends keyof CommonMessageHeaders
    ? CommonMessageHeaders[T]
    : unknown;

export abstract class Message<
    T extends Record<string, any> = Record<string, unknown>,
> {
    protected headers!: MessageHeaders;

    public static getSchemaVersion(): Version {
        return (this as any).schemaVersion ?? undefined;
    }

    public static getType(): string {
        return (this as any).type ?? this.name;
    }

    protected static newHeader(): MessageHeaders {
        return generateHeaderFor(this as any);
    }

    public static from(
        rawPayload: Record<string, unknown>,
        headers?: Record<string, unknown>
    ): Message {
        const clazz = this as any;
        const payload = clazz.deserializeRawPayload(rawPayload);
        return new clazz(payload, headers);
    }

    protected static deserializeRawPayload(rawPayload: any): any {
        return rawPayload;
    }

    constructor(
        protected readonly payload: T,
        headers?: MessageHeaders
    ) {
        this.headers = headers ?? (this.constructor as any).newHeader();
    }

    public setHeader(field: ExtraHeaderField, value: unknown): void {
        this.headers[field] = value;
    }

    public getHeader<T extends string>(field: T): KnownHeaderOrUnknown<T> {
        return this.headers[field] as KnownHeaderOrUnknown<T>;
    }

    public getPayload(): T {
        return this.payload;
    }

    public getMessageId(): string {
        return this.headers.id;
    }

    public getMessageType(): string {
        return this.getHeader("type");
    }

    public getSchemaVersion(): Version | undefined {
        return this.getHeader("schemaVersion");
    }

    public getTimestamp(): Date {
        return this.getHeader("createdAt");
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
}

export type AnyMessage = Message<any>;

export type MessageClass<T extends AnyMessage = AnyMessage> = {
    getSchemaVersion(): Version;
    getType(): string;
    from: (rawPayload: any, header?: MessageHeaders) => T;
    new (...args: any[]): T;
};

function generateHeaderFor(cls: MessageClass): MessageHeaders {
    return {
        id: uuid(),
        type: cls.getType(),
        schemaVersion: cls.getSchemaVersion(),
        createdAt: new Date(),
    };
}
