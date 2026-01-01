import { isEmpty } from "./is-empty";

export class FooValidator {
    public static validateFoo(value: string) {
        if (isEmpty(value)) throw new Error("foo is required");

        return value;
    }
}
