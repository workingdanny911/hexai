import { BaseApplicationContext } from "@/application";

export interface ApplicationContextAware<
    C extends BaseApplicationContext = BaseApplicationContext,
> {
    setApplicationContext(context: C): void;
}
