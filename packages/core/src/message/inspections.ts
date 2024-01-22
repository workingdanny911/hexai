import { isClass } from "@/utils";
import { Message, MessageClass } from "./message";

export function isMessageClass(value: unknown): value is MessageClass {
    return isClass(value) && value.prototype instanceof Message;
}
