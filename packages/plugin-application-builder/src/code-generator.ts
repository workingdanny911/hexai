import { BuildPluginConfig } from "./config";
import {
    DuplicateCommandHandlerError,
    DuplicateEventHandlerError,
    DuplicateQueryHandlerError,
} from "./errors";
import {
    HandlerMetadata,
    CommandHandlerMetadata,
    EventHandlerMetadata,
    QueryHandlerMetadata,
} from "./types";

/**
 * Generates TypeScript code for ApplicationBuilder
 */
export class ApplicationCodeGenerator {
    constructor(private config: BuildPluginConfig) {}

    generateCode(handlers: HandlerMetadata[]): string {
        this.validateNoDuplicates(handlers);
        const imports = this.collectImports(handlers);
        const registrations = this.generateRegistrations(handlers);
        return this.assembleGeneratedCode(imports, registrations);
    }

    private validateNoDuplicates(handlers: HandlerMetadata[]): void {
        this.validateNoDuplicateCommandHandlers(handlers);
        this.validateNoDuplicateEventHandlers(handlers);
        this.validateNoDuplicateQueryHandlers(handlers);
    }

    private validateNoDuplicateHandlers<T extends HandlerMetadata>(
        handlers: HandlerMetadata[],
        typeFilter: (h: HandlerMetadata) => h is T,
        keyExtractor: (h: T) => string,
        errorFactory: (key: string, handlers: string[]) => Error
    ): void {
        const filteredHandlers = handlers.filter(typeFilter);

        const keyToHandlers = new Map<string, string[]>();
        for (const handler of filteredHandlers) {
            const key = keyExtractor(handler);
            const existing = keyToHandlers.get(key) ?? [];
            existing.push(handler.handlerClassName);
            keyToHandlers.set(key, existing);
        }

        for (const [key, handlerList] of keyToHandlers) {
            if (handlerList.length > 1) {
                throw errorFactory(key, handlerList);
            }
        }
    }

    private validateNoDuplicateCommandHandlers(
        handlers: HandlerMetadata[]
    ): void {
        this.validateNoDuplicateHandlers(
            handlers,
            (h): h is CommandHandlerMetadata => h.type === "command",
            (h) => h.commandClassName,
            (key, handlers) => new DuplicateCommandHandlerError(key, handlers)
        );
    }

    private validateNoDuplicateEventHandlers(
        handlers: HandlerMetadata[]
    ): void {
        const eventHandlers = handlers.filter(
            (h): h is EventHandlerMetadata => h.type === "event"
        );

        const namedEventHandlers = eventHandlers.filter(
            (h) => h.eventHandlerOptions.name !== undefined
        );

        this.validateNoDuplicateHandlers(
            namedEventHandlers,
            (h): h is EventHandlerMetadata => true,
            (h) => h.eventHandlerOptions.name!,
            (key, handlers) => new DuplicateEventHandlerError(key, handlers)
        );
    }

    private validateNoDuplicateQueryHandlers(
        handlers: HandlerMetadata[]
    ): void {
        this.validateNoDuplicateHandlers(
            handlers,
            (h): h is QueryHandlerMetadata => h.type === "query",
            (h) => h.queryClassName,
            (key, handlers) => new DuplicateQueryHandlerError(key, handlers)
        );
    }

    private createImportStatement(
        symbolName: string,
        importPath: string
    ): string {
        return `import { ${symbolName} } from '${importPath}';`;
    }

    private createCommandHandlerRegistration(
        commandClassName: string,
        handlerClassName: string
    ): string {
        return `    .withCommandHandler(${commandClassName}, () => new ${handlerClassName}())`;
    }

    private createEventHandlerRegistration(
        handlerClassName: string,
        eventName?: string
    ): string {
        const nameArg = eventName ? `, '${eventName}'` : "";
        return `    .withEventHandler(() => new ${handlerClassName}()${nameArg})`;
    }

    private createQueryHandlerRegistration(
        queryClassName: string,
        handlerClassName: string
    ): string {
        return `    .withQueryHandler(${queryClassName}, () => new ${handlerClassName}())`;
    }

    private isCommandHandler(
        handler: HandlerMetadata
    ): handler is CommandHandlerMetadata {
        return handler.type === "command";
    }

    private isEventHandler(
        handler: HandlerMetadata
    ): handler is EventHandlerMetadata {
        return handler.type === "event";
    }

    private isQueryHandler(
        handler: HandlerMetadata
    ): handler is QueryHandlerMetadata {
        return handler.type === "query";
    }

    private collectImports(handlers: HandlerMetadata[]): Set<string> {
        const imports = new Set<string>();
        imports.add(
            this.createImportStatement(
                "ApplicationBuilder",
                this.config.applicationBuilderImportPath
            )
        );

        for (const handler of handlers) {
            imports.add(
                this.createImportStatement(
                    handler.handlerClassName,
                    handler.handlerPath
                )
            );

            if (this.isCommandHandler(handler) && handler.commandPath) {
                imports.add(
                    this.createImportStatement(
                        handler.commandClassName,
                        handler.commandPath
                    )
                );
            }

            if (this.isQueryHandler(handler) && handler.queryPath) {
                imports.add(
                    this.createImportStatement(
                        handler.queryClassName,
                        handler.queryPath
                    )
                );
            }
        }

        return imports;
    }

    private generateRegistrations(handlers: HandlerMetadata[]): string[] {
        const commandRegistrations =
            this.generateCommandRegistrations(handlers);
        const queryRegistrations = this.generateQueryRegistrations(handlers);
        const eventRegistrations = this.generateEventRegistrations(handlers);
        return [...commandRegistrations, ...queryRegistrations, ...eventRegistrations];
    }

    private generateCommandRegistrations(
        handlers: HandlerMetadata[]
    ): string[] {
        return handlers
            .filter((h): h is CommandHandlerMetadata =>
                this.isCommandHandler(h)
            )
            .map((h) =>
                this.createCommandHandlerRegistration(
                    h.commandClassName,
                    h.handlerClassName
                )
            );
    }

    private generateQueryRegistrations(
        handlers: HandlerMetadata[]
    ): string[] {
        return handlers
            .filter((h): h is QueryHandlerMetadata =>
                this.isQueryHandler(h)
            )
            .map((h) =>
                this.createQueryHandlerRegistration(
                    h.queryClassName,
                    h.handlerClassName
                )
            );
    }

    private generateEventRegistrations(handlers: HandlerMetadata[]): string[] {
        return handlers
            .filter((h): h is EventHandlerMetadata => this.isEventHandler(h))
            .map((handler) => {
                this.validateEventHandlerOptions(handler);
                const eventName = handler.eventHandlerOptions.name;
                return this.createEventHandlerRegistration(
                    handler.handlerClassName,
                    eventName
                );
            });
    }

    private validateEventHandlerOptions(handler: EventHandlerMetadata): void {
        const options = handler.eventHandlerOptions;
        const invalidKeys = Object.keys(options).filter(
            (key) => key !== "name"
        );

        if (invalidKeys.length > 0) {
            throw new Error(
                `EventHandler for ${handler.handlerClassName} has invalid options: ${invalidKeys.join(", ")}.\n` +
                    `Only 'name' option is supported. Use @EventHandler({ name: 'event-name' })`
            );
        }
    }

    private assembleGeneratedCode(
        imports: Set<string>,
        registrations: string[]
    ): string {
        const registrationCode =
            registrations.length > 0 ? "\n" + registrations.join("\n") : "";

        return `
${Array.from(imports).join("\n")}

export function createApplicationBuilder(): ApplicationBuilder {
  return new ApplicationBuilder()${registrationCode};
}
`;
    }
}
