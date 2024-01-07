import { CommonApplicationContext } from "src/application/common-application-context";

export interface ApplicationContextAware<
    C extends CommonApplicationContext = CommonApplicationContext,
> {
    setApplicationContext(context: C): void;
}
