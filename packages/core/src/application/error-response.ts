export type ErrorResponse =
    | ValidationErrorResponse
    | SystemErrorResponse
    | UnknownErrorResponse
    | AuthErrorResponse;

export function isErrorResponse(response: unknown): response is ErrorResponse {
    return (
        typeof response === "object" &&
        response !== null &&
        "errorType" in response
    );
}

export interface ValidationErrorResponse {
    errorType: "VALIDATION_ERROR";
    fields: Record<
        string,
        {
            code: string;
            message?: string;
        }
    >;
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

export function validationErrorResponse(
    fields: Record<string, string> | Record<string, [string, string]>
): ValidationErrorResponse {
    return {
        errorType: "VALIDATION_ERROR",
        fields: Object.entries(fields).reduce(
            (acc, [field, codeAndMessage]) => {
                const [code, message] =
                    typeof codeAndMessage === "string"
                        ? [codeAndMessage, undefined]
                        : codeAndMessage;

                acc[field] = { code, message };
                return acc;
            },
            {} as ValidationErrorResponse["fields"]
        ),
    };
}

export function systemErrorResponse<T = unknown>(
    message: string,
    details?: T
): SystemErrorResponse<T> {
    return {
        errorType: "SYSTEM_ERROR",
        message,
        details,
    };
}

export function unknownErrorResponse(message: string): UnknownErrorResponse {
    return {
        errorType: "UNKNOWN_ERROR",
        message,
    };
}

export function authErrorResponse(message: string): AuthErrorResponse {
    return {
        errorType: "AUTH_ERROR",
        message,
    };
}
