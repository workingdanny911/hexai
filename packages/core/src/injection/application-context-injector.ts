import { BaseApplicationContext } from "@/application";
import { AbstractInjector } from "./abstract-injector";
import { ApplicationContextAware } from "./application-context-aware";
import { isApplicationContextAware } from "./inspection";

export class ApplicationContextInjector extends AbstractInjector<
    BaseApplicationContext,
    ApplicationContextAware
> {
    protected override isInjectable(
        candidate: unknown
    ): candidate is ApplicationContextAware {
        return isApplicationContextAware(candidate);
    }

    protected override doInject(
        target: ApplicationContextAware,
        injectingObject: BaseApplicationContext
    ): void {
        target.setApplicationContext(injectingObject);
    }
}
