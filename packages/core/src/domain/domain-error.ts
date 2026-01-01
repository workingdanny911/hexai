export class DomainError extends Error {}

export class InvariantNotSatisfiedError extends DomainError {
    constructor(
        public readonly code: string,
        message: string = ""
    ) {
        super(message);
        this.name = "InvariantNotSatisfiedError";
    }
}

export class ValidationError extends InvariantNotSatisfiedError {
    constructor(
        public readonly field: string,
        code: string,
        message: string = ""
    ) {
        super(code, message);

        this.name = "ValidationError";
    }
}
