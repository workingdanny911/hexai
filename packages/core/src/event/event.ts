export interface Event<T extends string = string, P = unknown> {
    type: T;
    payload: P;
    occurredAt: Date;
}
