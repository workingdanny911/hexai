import { EventPublisher } from "@/event-publisher";
import { DomainEvent } from "./domain-event";

export interface DomainEventPublisher extends EventPublisher<DomainEvent> {}
