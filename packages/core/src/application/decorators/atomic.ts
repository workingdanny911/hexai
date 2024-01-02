import { UnitOfWorkHolder } from "@/helpers";
import { OptionsOfUnitOfWork, UnitOfWork } from "@/infra";

export function Atomic<U extends UnitOfWork = UnitOfWork>(
    options?: OptionsOfUnitOfWork<U>
) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (
            this: UnitOfWorkHolder<U>,
            ...args: any[]
        ) {
            if ("getUnitOfWork" in this) {
                const uow = this.getUnitOfWork();
                return uow.wrap(
                    () => originalMethod.apply(this, args),
                    options
                );
            } else {
                throw new Error("UnitOfWorkHolder not implemented");
            }
        };

        return descriptor;
    };
}
