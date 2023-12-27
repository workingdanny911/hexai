import { UnitOfWorkHolder } from "@/helpers";
import { BaseUnitOfWorkOptions } from "@/infra";

export function Atomic(options?: BaseUnitOfWorkOptions) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (
            this: UnitOfWorkHolder,
            ...args: any[]
        ) {
            if ("getUnitOfWork" in this) {
                const uow = this.getUnitOfWork();
                return uow.wrap(
                    () => originalMethod.apply(this, args),
                    options
                );
            } else {
                return originalMethod.apply(this, args);
            }
        };

        return descriptor;
    };
}
