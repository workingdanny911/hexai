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

    public override async publish(event: I): Promise<void> {
        await super.publish(event);
        this.events.push(event);
    }
}
