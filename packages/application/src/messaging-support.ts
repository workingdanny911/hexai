import { Message } from "@hexaijs/core";

export interface MessageTrace {
    id: string;
    type: string;
}

export function asTrace(message: Message): MessageTrace {
    return {
        id: message.getMessageId(),
        type: message.getMessageType(),
    };
}

// Causation functions
export function causationOf(message: Message): MessageTrace | undefined {
    const causationId = message.getHeader("causationId");
    const causationType = message.getHeader("causationType");
    if (causationId && causationType) {
        return { id: causationId, type: causationType };
    }
}

export function setCausationOf<T extends Message>(
    message: T,
    causation: MessageTrace
): T {
    return message
        .withHeader("causationId", causation.id)
        .withHeader("causationType", causation.type);
}

// Correlation functions
export function correlationOf(message: Message): MessageTrace | undefined {
    const correlationId = message.getHeader("correlationId");
    const correlationType = message.getHeader("correlationType");
    if (correlationId && correlationType) {
        return { id: correlationId, type: correlationType };
    }
}

export function setCorrelationOf<T extends Message>(
    message: T,
    correlation: MessageTrace
): T {
    return message
        .withHeader("correlationId", correlation.id)
        .withHeader("correlationType", correlation.type);
}
