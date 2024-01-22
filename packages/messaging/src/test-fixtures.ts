import { Message } from "@hexai/core";

export class FooMessage extends Message<Record<never, never>> {
    public static readonly type = "foo";

    public static create(): FooMessage {
        return new FooMessage({});
    }
}

export class BarMessage extends Message<Record<never, never>> {
    public static readonly type = "bar";

    public static create(): BarMessage {
        return new BarMessage({});
    }
}

export class BazMessage extends Message<Record<never, never>> {
    public static readonly type = "baz";

    public static create(): BazMessage {
        return new BazMessage({});
    }
}
