export interface AuthFilter<Principal = any, Request = any> {
    (principal: Principal, request: Request): Promise<void>;
}

export interface Authenticator<Factor = any, Principal = any> {
    (factor: Factor): Promise<Principal>;
}
