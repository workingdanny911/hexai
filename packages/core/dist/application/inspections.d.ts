import { C } from "ts-toolbelt";
import { ApplicationContextAware } from "./application-context-aware";
import { UseCase } from "./use-case";
import { EventPublisherAware } from "./event-publisher-aware";
export declare function isApplicationContextAware(value: unknown): value is ApplicationContextAware<any>;
export declare function isUseCaseClass(obj: object): obj is C.Class<[object], UseCase>;
export declare function isEventPublisherAware(value: unknown): value is EventPublisherAware;
//# sourceMappingURL=inspections.d.ts.map