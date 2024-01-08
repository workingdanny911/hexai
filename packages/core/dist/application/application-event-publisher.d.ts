import { EventPublisher } from "./event-publisher";
interface PublishCallback<E extends object, C extends object> {
    (event: E, context: C | null): void | Promise<void>;
}
export declare class ApplicationEventPublisher<E extends object = any, C extends object = any> implements EventPublisher {
    private callbacks;
    private contextStorage;
    bindContext<R>(context: C, callback: () => Promise<R>): Promise<R>;
    onPublish(callback: PublishCallback<E, C>): void;
    publish(events: E[]): Promise<void>;
    private runCallbacks;
    private getCurrentContext;
}
export type EventContextOf<P> = P extends ApplicationEventPublisher<any, infer C> ? C : never;
export {};
//# sourceMappingURL=application-event-publisher.d.ts.map