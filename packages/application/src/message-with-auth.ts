import { Message } from "@hexaijs/core";

export class MessageWithAuth<
    Payload = any,
    _ResultType = unknown,
    SecCtx = unknown,
> extends Message<Payload> {
    declare readonly ResultType: _ResultType;

    private securityContext?: SecCtx;

    constructor(
        payload: Payload,
        headers: Record<string, unknown> = {},
        securityContext?: SecCtx
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

    public getSecurityContext(): SecCtx {
        if (!this.securityContext) {
            throw new Error("security context is not set");
        }

        return this.securityContext as SecCtx;
    }

    public withSecurityContext(securityContext: SecCtx): this {
        const cloned = this.clone();
        cloned.securityContext = securityContext;
        return cloned;
    }
}
