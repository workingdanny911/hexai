export interface AuthFilter<SecurityContext = any, Message = any> {
    (securityContext: SecurityContext, message: Message): void | Promise<void>;
}

export interface Authenticator<Factor = any, SecurityContext = any> {
    (factor: Factor): SecurityContext | Promise<SecurityContext>;
}

export type FactorOf<A extends Authenticator> = A extends Authenticator<
    infer Factor
>
    ? Factor
    : never;

export type SecurityContextOf<A extends Authenticator> =
    A extends Authenticator<any, infer SecurityContext>
        ? SecurityContext
        : never;
