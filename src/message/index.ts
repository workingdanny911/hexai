import { v4 as uuid } from "uuid";

export interface MessageMeta {
    id: string;
    type: string;
}

type Version = string | number | undefined;

export interface MessageHeader {
    id: string;
    type: string;
    schemaVersion: Version;
    createdAt: Date;
    causation?: MessageMeta;
    correlation?: MessageMeta;
    returnAddress?: string;
}

export abstract class Message<
    T extends Record<string, any> = Record<string, unknown>,
> {
    protected readonly header: MessageHeader;

    public static getSchemaVersion(): Version {
        return (this as any).schemaVersion ?? undefined;
    }

    public static getType(): string {
        return (this as any).type ?? this.name;
    }

    protected static newHeader(): MessageHeader {
        return generateHeaderFor(this as any);
    }

    public static from(
        rawPayload: Record<string, unknown>,
        header?: MessageHeader
    ): Event {
        const clazz = this as any;
        const payload = clazz.deserializeRawPayload(rawPayload);
        return new clazz(payload, header);
    }

    protected static deserializeRawPayload(rawPayload: any): any {
        return rawPayload;
    }

    constructor(
        protected readonly payload: T,
        header?: MessageHeader
    ) {
        if (!header) {
            this.header = (this.constructor as any).newHeader();
        } else {
            this.header = header;
        }
    }

    public getPayload(): T {
        return this.payload;
    }

    public getMessageId(): string {
        return this.header.id;
    }

    public getMessageType(): string {
        return this.header.type;
    }

    public getSchemaVersion(): Version {
        return this.header.schemaVersion;
    }

    public getTimestamp(): Date {
        return this.header.createdAt;
    }

    public setCause(message: Message): void {
        this.setCausation(message);
        this.setCorrelation(message);
    }

    private setCausation(message: Message): void {
        this.header.causation = {
            id: message.getMessageId(),
            type: message.getMessageType(),
        };
    }

    public getCausation(): MessageMeta | undefined {
        return this.header.causation;
    }

    private setCorrelation(message: Message): void {
        this.header.correlation = message.getCorrelation() ?? {
            id: message.getMessageId(),
            type: message.getMessageType(),
        };
    }

    public getCorrelation(): MessageMeta | undefined {
        return this.header.correlation;
    }
}

export type AnyMessage = Message<any>;

export type PayloadTypeOfMessage<T extends AnyMessage> = T extends Message<
    infer P
>
    ? P
    : never;

export type MessageClass<T extends AnyMessage = AnyMessage> = {
    getSchemaVersion(): Version;
    getType(): string;
    from: (rawPayload: Record<string, unknown>, header?: MessageHeader) => T;
    new (...args: any[]): T;
};

function generateHeaderFor(
    cls: MessageClass,
    extra: {
        returnAddress?: string;
    } = {}
): MessageHeader {
    return {
        id: uuid(),
        type: cls.getType(),
        schemaVersion: cls.getSchemaVersion(),
        createdAt: new Date(),
        returnAddress: extra.returnAddress,
    };
}

export abstract class Event<
    T extends Record<string, any> = Record<string, unknown>,
> extends Message<T> {
    public serialize(): {
        header: MessageHeader;
        payload: Record<string, unknown>;
    } {
        return {
            header: this.header,
            payload: this.serializePayload(this.payload),
        };
    }

    protected abstract serializePayload(payload: T): Record<string, unknown>;
}

export abstract class Command<
    T extends Record<string, any> = Record<string, unknown>,
> extends Message<T> {}
