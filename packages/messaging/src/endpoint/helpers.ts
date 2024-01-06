import {
    AnyMessageHandler,
    MessageHandlerFunctionFrom,
} from "./message-handler";

export function toHandlerFunction<T extends AnyMessageHandler>(
    handler: T
): MessageHandlerFunctionFrom<T> {
    if (typeof handler === "function") {
        return handler as MessageHandlerFunctionFrom<T>;
    } else {
        return handler.handle.bind(handler) as MessageHandlerFunctionFrom<T>;
    }
}
