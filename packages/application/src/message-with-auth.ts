import { Message, MessageOptions } from "@hexaijs/core";

export interface MessageWithAuthOptions<SecCtx = unknown>
    extends MessageOptions {
    securityContext?: SecCtx;
}

export class MessageWithAuth<
    Payload = any,
    _ResultType = unknown,
    SecCtx = unknown,
> extends Message<Payload> {
    declare readonly ResultType: _ResultType;

    private securityContext?: SecCtx;

    constructor(
        payload: Payload,
        options?: MessageWithAuthOptions<SecCtx>
    ) {
        super(payload, options);
        this.securityContext = options?.securityContext;
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
