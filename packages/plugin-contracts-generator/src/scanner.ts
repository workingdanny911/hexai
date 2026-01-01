import { glob } from "glob";

import { FileReadError } from "./errors";
import { FileSystem, nodeFileSystem } from "./file-system";
import type { DecoratorNames, MessageType } from "./domain";
import { mergeDecoratorNames } from "./domain";

const DEFAULT_EXCLUDE_PATTERNS = [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.spec.ts",
];

export interface ScannerOptions {
    exclude?: string[];
    fileSystem?: FileSystem;
    decoratorNames?: DecoratorNames;
    /**
     * Filter which message types to scan for.
     * Defaults to all types: ['event', 'command', 'query']
     */
    messageTypes?: MessageType[];
}

export class Scanner {
    private readonly exclude: string[];
    private readonly fs: FileSystem;
    private readonly decoratorPatterns: string[];

    constructor(options: ScannerOptions = {}) {
        this.exclude = options.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
        this.fs = options.fileSystem ?? nodeFileSystem;

        const names = mergeDecoratorNames(options.decoratorNames);
        const messageTypes = options.messageTypes ?? ['event', 'command', 'query'];

        this.decoratorPatterns = messageTypes.map((type) => {
            const decoratorName = names[type];
            return `@${decoratorName}(`;
        });
    }

    async scan(sourceDir: string): Promise<string[]> {
        const files = await glob(`${sourceDir}/**/*.ts`, {
            ignore: this.exclude,
        });
        const result: string[] = [];

        for (const file of files) {
            let content: string;
            try {
                content = await this.fs.readFile(file);
            } catch (error) {
                throw new FileReadError(file, { cause: error });
            }

            if (this.containsPublicDecorator(content)) {
                result.push(file);
            }
        }

        return result;
    }

    private containsPublicDecorator(content: string): boolean {
        return this.decoratorPatterns.some(pattern => content.includes(pattern));
    }
}
