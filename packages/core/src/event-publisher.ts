export interface EventPublisher<E = any> {
    publish(...events: E[]): void;
}
