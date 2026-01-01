/**
 * Error thrown when config validation fails.
 * Contains all validation errors collected during config resolution.
 */
export class ConfigValidationError extends Error {
    constructor(public readonly errors: string[]) {
        super(`Config validation failed:\n  - ${errors.join("\n  - ")}`);
        this.name = "ConfigValidationError";
    }
}
