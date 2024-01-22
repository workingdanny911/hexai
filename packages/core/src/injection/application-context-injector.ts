import {
    ApplicationContextAware,
    isApplicationContextAware,
} from "@/application";

import { AbstractInjector } from "./abstract-injector";

export class ApplicationContextInjector<
    C extends object = object,
> extends AbstractInjector<C, ApplicationContextAware<C>> {
    protected override isInjectable(
        candidate: unknown
    ): candidate is ApplicationContextAware<C> {
        return isApplicationContextAware(candidate);
    }

    protected override doInject(
        target: ApplicationContextAware<C>,
        injectingObject: C
    ): void {
        target.setApplicationContext(injectingObject);
    }
}
