export interface EventPublisher<E extends object = object> {
    publish(events: E[]): Promise<void>;
}
//# sourceMappingURL=event-publisher.d.ts.map