import { ObjectRegistry } from "@/utils";

import { AnyMessage, MessageClass, MessageHeaders } from "./message";

export class MessageRegistry {
    private readonly registry = new ObjectRegistry();

    public register(messageClass: MessageClass): void {
        const type = messageClass.getType();
        const version = messageClass.getSchemaVersion();
        const key = makeKey(type, version);

        if (this.registry.isRegistered(key)) {
            throw new Error(`${format(type, version)} is already registered.`);
        }

        // @ts-expect-error: to use spread operator
        const factory = (...args: any[]) => messageClass.from(...args);
        this.registry.register(key, factory);
    }

    public dehydrate<T extends AnyMessage = AnyMessage>(
        header: MessageHeaders,
        body: Record<string, unknown>
    ): T {
        const { type, schemaVersion } = header;
        const key = makeKey(type, schemaVersion);

        if (!this.registry.isRegistered(key)) {
            throw new Error(
                `${format(type, schemaVersion)} is not registered.`
            );
        }

        return this.registry.createFrom(key, body, header);
    }
}

function makeKey(type: string, version?: string | number): string {
    const versionPart = version ? `:${version}` : "";
    return `event:${type}${versionPart}`;
}

function format(type: string, version?: any): string {
    return `'${type}'${version ? ` with version '${version}'` : ""}`;
}
