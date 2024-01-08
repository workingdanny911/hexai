import { EventPublisher } from "./event-publisher";
export interface EventPublisherAware<E extends object = object> {
    setEventPublisher(publisher: EventPublisher<E>): void;
}
//# sourceMappingURL=event-publisher-aware.d.ts.map