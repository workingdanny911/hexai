import { L } from "ts-toolbelt";
import { describe, test } from "vitest";

import { AnyMessage, Message } from "@/message";
import { MessageHandler } from "./message-handler";
import { Application, ApplicationEventMap } from "./application";
import { ApplicationEventPublisher } from "./application-event-publisher";

interface GenericEventPublishingContext {
    causeMessage: Message;
}

interface GenericApplicationContext {
    getEventPublisher(): ApplicationEventPublisher<
        AnyMessage,
        GenericEventPublishingContext
    >;
}

class GenericApplication<
    Ctx extends GenericApplicationContext,
    Handlers extends L.List<MessageHandler<AnyMessage>>,
    EventMap extends ApplicationEventMap = ApplicationEventMap,
> extends Application<Ctx, Handlers, EventMap> {}

/** Todo
 * Event publishing context binding
 * Error Handling
 * Observability
 */
describe.skip("GenericApplication", () => {});
