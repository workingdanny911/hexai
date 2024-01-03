import { BaseApplicationContext } from "@/application";
import { Injector } from "./injector";
import { ApplicationContextAware } from "./application-context-aware";
import { isApplicationContextAware } from "./inspection";

export class ApplicationContextInjector<C extends BaseApplicationContext>
    implements Injector<ApplicationContextAware<C>, C>
{
    private applicationContext!: C;

    canInjectTo(target: unknown): target is ApplicationContextAware<C> {
        return isApplicationContextAware(target);
    }

    injectTo(target: ApplicationContextAware<C>): void {
        if (!this.applicationContext) {
            throw new Error(
                "Injecting object is not set. Use 'setInjectingObject' method to set it."
            );
        }

        if (!this.canInjectTo(target)) {
            throw new Error(
                `Target object '${target}' is not an 'ApplicationContextAware'.`
            );
        }

        target.setApplicationContext(this.applicationContext);
    }

    setInjectingObject(injectingObject: C): void {
        this.applicationContext = injectingObject;
    }
}
