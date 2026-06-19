import type {
    DomainEvent,
    Command,
    Query,
    OutputModuleSpecifiers,
} from "./domain/types.js";
import {
    DEFAULT_OUTPUT_MODULE_SPECIFIERS,
    formatRelativeIndexSpecifier,
} from "./module-specifier.js";

type Message = DomainEvent | Command | Query;

export interface RegistryGeneratorOptions {
    readonly messageRegistryImport: string;
    readonly useNamespace?: boolean;
    readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export interface ContextMessages {
    readonly contextName: string;
    readonly events: readonly DomainEvent[];
    readonly commands: readonly Command[];
    readonly queries?: readonly Query[];
    readonly importPath?: string;
}

const DEFAULT_OPTIONS: RegistryGeneratorOptions = {
    messageRegistryImport: "@hexaijs/plugin-contracts-generator/runtime",
    outputModuleSpecifiers: DEFAULT_OUTPUT_MODULE_SPECIFIERS,
};

function hasMessages(ctx: ContextMessages): boolean {
    return (
        ctx.events.length > 0 ||
        ctx.commands.length > 0 ||
        (ctx.queries?.length ?? 0) > 0
    );
}

function getAllMessages(ctx: ContextMessages): readonly Message[] {
    return [...ctx.events, ...ctx.commands, ...(ctx.queries ?? [])];
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
    return [...items].sort((a, b) => compareStrings(a.name, b.name));
}

function sortContexts(
    contexts: readonly ContextMessages[]
): ContextMessages[] {
    return [...contexts]
        .sort((a, b) => compareStrings(a.contextName, b.contextName))
        .map((ctx) => ({
            ...ctx,
            events: sortByName(ctx.events),
            commands: sortByName(ctx.commands),
            queries: ctx.queries ? sortByName(ctx.queries) : undefined,
        }));
}

export class RegistryGenerator {
    private readonly options: RegistryGeneratorOptions;

    constructor(options: Partial<RegistryGeneratorOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    generate(contexts: readonly ContextMessages[]): string {
        const sorted = sortContexts(contexts);

        const allMessages = sorted.flatMap((ctx) =>
            getAllMessages(ctx).map((message) => ({
                message,
                contextName: ctx.contextName,
            }))
        );

        if (allMessages.length === 0) {
            return this.generateEmptyRegistry();
        }

        if (this.options.useNamespace) {
            return this.generateWithNamespace(sorted, allMessages);
        }

        const imports = this.generateImports(sorted);
        const registrations = this.generateRegistrations(allMessages);

        return [
            imports,
            "",
            "export const messageRegistry = new MessageRegistry()",
            registrations,
        ].join("\n");
    }

    private generateEmptyRegistry(): string {
        return [
            `import { MessageRegistry } from "${this.options.messageRegistryImport}";`,
            "",
            "export const messageRegistry = new MessageRegistry();",
            "",
        ].join("\n");
    }

    private generateWithNamespace(
        contexts: readonly ContextMessages[],
        allMessages: readonly { message: Message; contextName: string }[]
    ): string {
        const imports = this.generateNamespaceImports(contexts);
        const exports = this.generateNamespaceExports(contexts);
        const registrations = this.generateNamespaceRegistrations(allMessages);

        return [
            imports,
            "",
            exports,
            "",
            "export const messageRegistry = new MessageRegistry()",
            registrations,
        ].join("\n");
    }

    private getNamespaceInfos(
        contexts: readonly ContextMessages[]
    ): Array<{ importPath: string; namespace: string }> {
        return contexts.filter(hasMessages).map((ctx) => ({
            importPath: ctx.importPath ?? this.createContextImportPath(ctx.contextName),
            namespace: this.toNamespace(ctx.contextName),
        }));
    }

    private createContextImportPath(contextName: string): string {
        return formatRelativeIndexSpecifier(
            `./${contextName}`,
            this.options.outputModuleSpecifiers ?? DEFAULT_OUTPUT_MODULE_SPECIFIERS
        );
    }

    private generateNamespaceImports(
        contexts: readonly ContextMessages[]
    ): string {
        return [
            `import { MessageRegistry } from "${this.options.messageRegistryImport}";`,
            ...this.getNamespaceInfos(contexts).map(
                ({ importPath, namespace }) =>
                    `import * as ${namespace} from "${importPath}";`
            ),
        ].join("\n");
    }

    private generateNamespaceExports(
        contexts: readonly ContextMessages[]
    ): string {
        return this.getNamespaceInfos(contexts)
            .map(
                ({ importPath, namespace }) =>
                    `export * as ${namespace} from "${importPath}";`
            )
            .join("\n");
    }

    private generateNamespaceRegistrations(
        messages: readonly { message: Message; contextName: string }[]
    ): string {
        const lines = messages.map(({ message, contextName }) => {
            const namespace = this.toNamespace(contextName);
            return `    .register(${namespace}.${message.name})`;
        });
        return lines.join("\n") + ";\n";
    }

    private toNamespace(contextName: string): string {
        // kebab-case to camelCase
        return contextName.replace(/-([a-z])/g, (_, letter) =>
            letter.toUpperCase()
        );
    }

    private generateImports(contexts: readonly ContextMessages[]): string {
        const lines: string[] = [
            `import { MessageRegistry } from "${this.options.messageRegistryImport}";`,
        ];

        for (const ctx of contexts) {
            const messageNames = getAllMessages(ctx).map((m) => m.name);

            if (messageNames.length > 0) {
                const importPath = ctx.importPath ?? this.createContextImportPath(ctx.contextName);
                lines.push(
                    `import { ${messageNames.join(", ")} } from "${importPath}";`
                );
            }
        }

        return lines.join("\n");
    }

    private generateRegistrations(
        messages: readonly { message: Message; contextName: string }[]
    ): string {
        const lines = messages.map(
            ({ message }) => `    .register(${message.name})`
        );
        return lines.join("\n") + ";\n";
    }
}
