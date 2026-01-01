import type { DomainEvent, Command, Query } from "./domain/types";

type Message = DomainEvent | Command | Query;

export interface RegistryGeneratorOptions {
    readonly messageRegistryImport: string;
    readonly useNamespace?: boolean;
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

export class RegistryGenerator {
    private readonly options: RegistryGeneratorOptions;

    constructor(options: Partial<RegistryGeneratorOptions> = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    generate(contexts: readonly ContextMessages[]): string {
        const allMessages = contexts.flatMap((ctx) =>
            getAllMessages(ctx).map((message) => ({
                message,
                contextName: ctx.contextName,
            }))
        );

        if (allMessages.length === 0) {
            return this.generateEmptyRegistry();
        }

        if (this.options.useNamespace) {
            return this.generateWithNamespace(contexts, allMessages);
        }

        const imports = this.generateImports(contexts);
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
            importPath: ctx.importPath ?? `./${ctx.contextName}`,
            namespace: this.toNamespace(ctx.contextName),
        }));
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
                const importPath = ctx.importPath ?? `./${ctx.contextName}`;
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
