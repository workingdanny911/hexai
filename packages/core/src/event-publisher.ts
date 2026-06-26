export interface EventPublisher<E extends object = any> {
    publish(...events: E[]): Promise<void>;
}

export type EventSubscriber<E extends object = any> = (
    event: E
) => void | Promise<void>;

export interface SubscribableEventPublisher<E extends object = any>
    extends EventPublisher<E> {
    subscribe(subscriber: EventSubscriber<E>): () => void;
}
