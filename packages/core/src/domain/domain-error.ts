export class DomainError extends Error {}

export class ValidationError extends DomainError {
    constructor(
        public field: string,
        public code: string,
        public message: string = ""
    ) {
        super(message);

        this.name = "ValidationError";
    }
}
