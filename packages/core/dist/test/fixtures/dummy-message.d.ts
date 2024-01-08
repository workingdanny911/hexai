import { Message, MessageHeaders } from "../../message";
export declare class DummyMessage extends Message<Record<never, never>> {
    static type: string;
    static create(): DummyMessage;
    static createMany(number: number): DummyMessage[];
    static from(_: Record<never, never>, headers?: MessageHeaders): DummyMessage;
}
//# sourceMappingURL=dummy-message.d.ts.map