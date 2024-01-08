import { ApplicationContextAware } from "../application";
import { AbstractInjector } from "./abstract-injector";
export declare class ApplicationContextInjector<C extends object = object> extends AbstractInjector<C, ApplicationContextAware<C>> {
    protected isInjectable(candidate: unknown): candidate is ApplicationContextAware<C>;
    protected doInject(target: ApplicationContextAware<C>, injectingObject: C): void;
}
//# sourceMappingURL=application-context-injector.d.ts.map