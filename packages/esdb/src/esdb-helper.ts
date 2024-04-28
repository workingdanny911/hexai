import {
    EventStoreDBClient,
    jsonEvent,
    JSONEventData,
    JSONEventType,
    JSONRecordedEvent,
    START,
    StreamNotFoundError,
    WrongExpectedVersionError,
} from "@eventstore/db-client";
import { Message, MessageHeaders, MessageRegistry } from "@hexai/core";

function isNonExistentStreamError(e: unknown): boolean {
    if (e instanceof StreamNotFoundError) {
        return true;
    }

    if (e instanceof WrongExpectedVersionError) {
        return (
            e.actualVersion === BigInt(-1) && e.expectedVersion === BigInt(-2)
        );
    }

    return false;
}

export class EsdbHelper {
    private static messageRegistry: MessageRegistry;

    public static bindMessageRegistry(messageRegistry: MessageRegistry) {
        this.messageRegistry = messageRegistry;
    }

    constructor(private client: EventStoreDBClient) {}

    public async publishToStream(
        stream: string,
        events: Array<Message>
    ): Promise<void> {
        const esdbEvents = events.map((e) => EsdbHelper.serialize(e));
        await this.client.appendToStream(stream, esdbEvents);
    }

    public static serialize(event: Message): JSONEventData {
        const { headers, payload } = event.serialize();
        return jsonEvent({
            id: headers.id,
            type: headers.type,
            data: payload,
            metadata: {
                causation: headers.causation,
                correlation: headers.correlation,
                createdAt: headers.createdAt,
                schemaVersion: headers.schemaVersion,
                returnAddress: headers.returnAddress,
            },
        });
    }

    public async readStream(
        stream: string,
        {
            fromPosition,
            numberOfEvents,
        }: {
            fromPosition?: number | bigint;
            numberOfEvents?: number;
        } = {}
    ): Promise<Array<Message>> {
        try {
            const events: Array<Message> = [];
            const fromRevision = fromPosition ? BigInt(fromPosition) : START;

            for await (const data of this.client.readStream<RawEventInStream>(
                stream,
                {
                    fromRevision,
                    maxCount: numberOfEvents,
                }
            )) {
                events.push(EsdbHelper.deserialize(data.event!));
            }

            return events;
        } catch (e) {
            if (e instanceof StreamNotFoundError) {
                return [];
            }

            throw e;
        }
    }

    public async deleteStream(stream: string): Promise<void> {
        try {
            await this.client.deleteStream(stream);
        } catch (e) {
            if (isNonExistentStreamError(e)) {
                return;
            }

            throw e;
        }
    }

    public static deserialize(rawEvent: RawEventInStream): Message {
        const headers: MessageHeaders = {
            id: rawEvent.id,
            type: rawEvent.type,
            ...rawEvent.metadata,
            createdAt: new Date(rawEvent.metadata.createdAt as string),
        };

        try {
            return EsdbHelper.messageRegistry.dehydrate(headers, rawEvent.data);
        } catch {
            return Message.from(rawEvent.data, headers);
        }
    }
}

export type RawEventInStream = JSONRecordedEvent<
    JSONEventType<
        string,
        Record<string, unknown>,
        Omit<MessageHeaders, "id" | "type">
    >
>;
