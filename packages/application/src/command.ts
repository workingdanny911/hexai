import { Message } from "@hexaijs/core";

export class Command<P = any, SC = any> extends Message<P> {
    static override getIntent(): string {
        return "command";
    }

    private securityContext?: SC;

    constructor(
        payload: P,
        headers: Record<string, unknown> = {},
        securityContext?: SC
    ) {
        super(payload, headers);
        this.securityContext = securityContext;
    }

    public override withHeader(field: string, value: unknown): this {
        const newHeaders = { ...this.getHeaders(), [field]: value };
        return this.cloneWithHeaders(newHeaders);
    }

    protected clone(): this {
        const cloned = Object.create(Object.getPrototypeOf(this));
        Object.assign(cloned, this);
        return cloned;
    }

    protected cloneWithHeaders(headers: Record<string, unknown>): this {
        const cloned = this.clone();
        // Bypass frozen headers from parent Message class
        Object.defineProperty(cloned, "headers", {
            value: Object.freeze(headers),
            writable: false,
            configurable: true,
        });
        return cloned;
    }

    public getSecurityContext(): SC {
        if (!this.securityContext) {
            throw new Error("security context is not set");
        }

        return this.securityContext!;
    }

    public withSecurityContext(securityContext: SC): this {
        const cloned = this.clone();
        cloned.securityContext = securityContext;
        return cloned;
    }
}
