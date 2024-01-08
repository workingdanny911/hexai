export type ErrorResponse = ValidationErrorResponse | SystemErrorResponse | UnknownErrorResponse | AuthErrorResponse;
export declare function isErrorResponse(response: unknown): response is ErrorResponse;
export interface ValidationErrorResponse {
    errorType: "VALIDATION_ERROR";
    fields: Record<string, {
        code: string;
        message?: string;
    }>;
}
export interface SystemErrorResponse<T = unknown> {
    errorType: "SYSTEM_ERROR";
    message: string;
    details?: T;
}
export interface UnknownErrorResponse {
    errorType: "UNKNOWN_ERROR";
    message: string;
}
export interface AuthErrorResponse {
    errorType: "AUTH_ERROR";
    message: string;
}
export declare function validationErrorResponse(fields: Record<string, string> | Record<string, [string, string]>): ValidationErrorResponse;
export declare function systemErrorResponse<T = unknown>(message: string, details?: T): SystemErrorResponse<T>;
export declare function unknownErrorResponse(message: string): UnknownErrorResponse;
export declare function authErrorResponse(message: string): AuthErrorResponse;
//# sourceMappingURL=error-response.d.ts.map