export declare class DomainError extends Error {
}
export declare class ValidationError extends DomainError {
    field: string;
    code: string;
    message: string;
    constructor(field: string, code: string, message?: string);
}
//# sourceMappingURL=domain-error.d.ts.map