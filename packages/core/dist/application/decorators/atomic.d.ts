import { OptionsOf } from "../../infra";
import { ApplicationContextAware, UnitOfWorkHolder } from "../../application";
type Options<C extends UnitOfWorkHolder> = OptionsOf<ReturnType<C["getUnitOfWork"]>>;
export declare function Atomic<C extends UnitOfWorkHolder>(options?: Options<C>): (target: ApplicationContextAware<C>, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
export {};
//# sourceMappingURL=atomic.d.ts.map