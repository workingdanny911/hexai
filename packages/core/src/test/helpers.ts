import { ApplicationEventPublisher } from "@/application";

export class TrackableEventPublisher<
    I extends object = any,
    O extends object = any,
> extends ApplicationEventPublisher<I, O> {
    private events: I[] = [];

    public getEventsPublished(): I[] {
        return this.events;
    }

    public clear(): void {
        this.events = [];
    }

    public override async publish(events: I[]): Promise<void> {
        await super.publish(events);
        this.events.push(...events);
    }
}
