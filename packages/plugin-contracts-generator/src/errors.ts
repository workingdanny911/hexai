/**
 * Base error class for all contracts-generator errors.
 * Allows catching all library errors with `instanceof MessageParserError`.
 */
export class MessageParserError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "MessageParserError";
    }
}

/**
 * Base class for configuration-related errors.
 */
export class ConfigurationError extends MessageParserError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ConfigurationError";
    }
}

/**
 * Error thrown when loading application.config.ts fails.
 */
export class ConfigLoadError extends ConfigurationError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ConfigLoadError";
    }
}

/**
 * Base class for file system operation errors.
 */
export class FileSystemError extends MessageParserError {
    readonly path: string;

    constructor(message: string, path: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "FileSystemError";
        this.path = path;
    }
}

/**
 * Error thrown when a required file is not found.
 */
export class FileNotFoundError extends FileSystemError {
    constructor(path: string, options?: ErrorOptions) {
        super(`File not found: ${path}`, path, options);
        this.name = "FileNotFoundError";
    }
}

/**
 * Error thrown when reading a file fails.
 */
export class FileReadError extends FileSystemError {
    constructor(path: string, options?: ErrorOptions) {
        super(`Failed to read file: ${path}`, path, options);
        this.name = "FileReadError";
    }
}

/**
 * Error thrown when writing a file fails.
 */
export class FileWriteError extends FileSystemError {
    constructor(path: string, options?: ErrorOptions) {
        super(`Failed to write file: ${path}`, path, options);
        this.name = "FileWriteError";
    }
}

/**
 * Base class for parsing errors.
 */
export class ParseError extends MessageParserError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ParseError";
    }
}

/**
 * Error thrown when JSON parsing fails.
 */
export class JsonParseError extends ParseError {
    readonly filePath?: string;

    constructor(message: string, filePath?: string, options?: ErrorOptions) {
        const fullMessage = filePath
            ? `Failed to parse JSON in ${filePath}: ${message}`
            : `Failed to parse JSON: ${message}`;
        super(fullMessage, options);
        this.name = "JsonParseError";
        this.filePath = filePath;
    }
}

/**
 * Base class for module/path resolution errors.
 */
export class ResolutionError extends MessageParserError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ResolutionError";
    }
}

/**
 * Error thrown when module resolution fails.
 */
export class ModuleResolutionError extends ResolutionError {
    readonly moduleSpecifier: string;
    readonly fromFile: string;

    constructor(moduleSpecifier: string, fromFile: string, options?: ErrorOptions) {
        super(
            `Failed to resolve module '${moduleSpecifier}' from '${fromFile}'`,
            options
        );
        this.name = "ModuleResolutionError";
        this.moduleSpecifier = moduleSpecifier;
        this.fromFile = fromFile;
    }
}
