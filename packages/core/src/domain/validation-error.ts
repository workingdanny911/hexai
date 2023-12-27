export default class ValidationError extends Error {
    constructor(
        public field: string,
        public code: string,
        public message: string = ""
    ) {
        super(message);

        this.name = "ValidationError";
    }
}
