import { UnitOfWork } from "../infra";
import { ApplicationEventPublisher } from "./application-event-publisher";
export interface CommonApplicationContext<U extends UnitOfWork<any, any> = UnitOfWork, E extends ApplicationEventPublisher = ApplicationEventPublisher> {
    getUnitOfWork(): U;
    getEventPublisher(): E;
}
//# sourceMappingURL=common-application-context.d.ts.map