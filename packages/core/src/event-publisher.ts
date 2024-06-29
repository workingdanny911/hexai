export interface EventPublisher<E extends object = any> {
    publish(event: E): void;
}

export interface AsyncEventPublisher<E extends object = any>
    extends EventPublisher<E> {
    publish(event: E): Promise<void>;
}
