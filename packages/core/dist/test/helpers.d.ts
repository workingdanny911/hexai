import { ApplicationEventPublisher } from "../application";
export declare class TrackableEventPublisher<I extends object = any, O extends object = any> extends ApplicationEventPublisher<I, O> {
    private events;
    getEventsPublished(): I[];
    clear(): void;
    publish(events: I[]): Promise<void>;
}
//# sourceMappingURL=helpers.d.ts.map