import {
    AnyMessage,
    Message,
    type EventSubscriber,
    type SubscribableEventPublisher,
} from "@hexaijs/core";

import { ExecutionScope } from "./execution-scope.js";

interface SecurityContextAwareMessage extends Message {
    withSecurityContext(securityContext: unknown): Message;
}

export class ApplicationEventPublisher
    implements SubscribableEventPublisher<Message> {
    private callbacks: Set<EventSubscriber<AnyMessage>> = new Set();

    public subscribe(callback: EventSubscriber<AnyMessage>): () => void {
        this.callbacks.add(callback);
        return () => this.unsubscribe(callback);
    }

    private unsubscribe(callback: EventSubscriber<AnyMessage>): void {
        this.callbacks.delete(callback);
    }

    public async publish(...events: Message[]): Promise<void> {
        const causation = ExecutionScope.getCausation();
        const correlation = ExecutionScope.getCorrelation();
        const securityContext = ExecutionScope.getSecurityContext();

        for (let event of events) {
            if (causation) {
                event = event
                    .withCausation(causation)
                    .withCorrelation(correlation ?? causation);
            }
            if (securityContext !== undefined) {
                event = this.withSecurityContext(event, securityContext);
            }
            await this.runCallbacks(event);
        }
    }

    private withSecurityContext(event: Message, securityContext: unknown): Message {
        if (!this.isSecurityContextAwareMessage(event)) {
            return event;
        }

        return event.withSecurityContext(securityContext);
    }

    private isSecurityContextAwareMessage(
        event: Message
    ): event is SecurityContextAwareMessage {
        const candidate = event as { withSecurityContext?: unknown };
        return typeof candidate.withSecurityContext === "function";
    }

    private async runCallbacks(event: Message): Promise<void> {
        await Promise.all([...this.callbacks].map((cb) => cb(event)));
    }
}
