import { Message } from "@hexaijs/core";
import { FooValidator } from "./foo.validator";
import { validateBar } from "./bar.validator";
import { PublicCommand } from "@/decorators";

@PublicCommand()
export class SomeCommand extends Message<{
    foo: string;
    bar: string;
}> {
    validate() {
        const { foo, bar } = this.getPayload();

        return {
            foo: FooValidator.validateFoo(foo),
            bar: validateBar(bar),
        };
    }
}
