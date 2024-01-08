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
type ExtraHeaderField = Exclude<keyof MessageHeaders, keyof CommonMessageHeaders>;
type KnownHeaderOrUnknown<T> = T extends keyof CommonMessageHeaders ? CommonMessageHeaders[T] : unknown;
export declare abstract class Message<T extends Record<string, any> = Record<string, unknown>> {
    protected readonly payload: T;
    protected headers: MessageHeaders;
    static getSchemaVersion(): Version;
    static getType(): string;
    protected static newHeader(): MessageHeaders;
    static from(rawPayload: Record<string, unknown>, headers?: Record<string, unknown>): Message;
    protected static deserializeRawPayload(rawPayload: any): any;
    constructor(payload: T, headers?: MessageHeaders);
    setHeader(field: ExtraHeaderField, value: unknown): void;
    getHeader<T extends string>(field: T): KnownHeaderOrUnknown<T>;
    getPayload(): T;
    getMessageId(): string;
    getMessageType(): string;
    getSchemaVersion(): Version | undefined;
    getTimestamp(): Date;
    serialize(): {
        headers: MessageHeaders;
        payload: Record<string, unknown>;
    };
    protected serializePayload(payload: T): Record<string, unknown>;
}
export type AnyMessage = Message<any>;
export type MessageClass<T extends AnyMessage = AnyMessage> = {
    getSchemaVersion(): Version;
    getType(): string;
    from: (rawPayload: any, header?: MessageHeaders) => T;
    new (...args: any[]): T;
};
export {};
//# sourceMappingURL=message.d.ts.map