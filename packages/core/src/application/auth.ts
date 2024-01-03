export interface AuthFilter<SecurityContext = any, Request = any> {
    (securityContext: SecurityContext, request: Request): Promise<void>;
}

export interface Authenticator<Factor = any, SecurityContext = any> {
    (factor: Factor): Promise<SecurityContext>;
}
