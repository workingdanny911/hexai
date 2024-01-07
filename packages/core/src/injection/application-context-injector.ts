import {
    ApplicationContextAware,
    CommonApplicationContext,
    isApplicationContextAware,
} from "@/application";

import { AbstractInjector } from "./abstract-injector";

export class ApplicationContextInjector extends AbstractInjector<
    CommonApplicationContext,
    ApplicationContextAware
> {
    protected override isInjectable(
        candidate: unknown
    ): candidate is ApplicationContextAware {
        return isApplicationContextAware(candidate);
    }

    protected override doInject(
        target: ApplicationContextAware,
        injectingObject: CommonApplicationContext
    ): void {
        target.setApplicationContext(injectingObject);
    }
}
