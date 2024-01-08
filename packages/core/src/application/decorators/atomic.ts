import { OptionsOf, UnitOfWork } from "@/infra";
import { ApplicationContextAware, UnitOfWorkHolder } from "@/application";

type Options<C extends UnitOfWorkHolder> = OptionsOf<
    ReturnType<C["getUnitOfWork"]>
>;

export function Atomic<C extends UnitOfWorkHolder>(options?: Options<C>) {
    return function (
        target: ApplicationContextAware<C>,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        if (typeof target.setApplicationContext !== "function") {
            throw new Error(
                `target '${target.constructor.name}' does not implement 'ApplicationContextAware'`
            );
        }

        let uow!: UnitOfWork;
        const origSetApplicationContext = target.setApplicationContext;
        target.setApplicationContext = function (
            this: ApplicationContextAware<C>,
            applicationContext: C
        ) {
            origSetApplicationContext.call(this, applicationContext);
            uow = applicationContext.getUnitOfWork();
        };

        const originalMethod = descriptor.value;
        descriptor.value = async function (
            this: ApplicationContextAware<C>,
            ...args: any[]
        ) {
            if (!uow) {
                throw new Error(
                    `application context not injected to '${target.constructor.name}'`
                );
            }

            return await uow.wrap(async () => {
                return await originalMethod.apply(this, args);
            }, options);
        };

        return descriptor;
    };
}
