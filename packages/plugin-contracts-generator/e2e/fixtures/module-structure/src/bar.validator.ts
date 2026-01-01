import { isEmpty } from "./is-empty";

export function validateBar(value: string) {
    if (isEmpty(value)) throw new Error("bar is required");

    return value;
}
