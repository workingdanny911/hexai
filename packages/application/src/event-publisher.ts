export interface EventPublisher<E extends object = any> {
    publish(...events: E[]): Promise<void>;
}
