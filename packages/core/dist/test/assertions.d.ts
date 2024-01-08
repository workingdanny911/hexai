import { AuthErrorResponse, SystemErrorResponse, UnknownErrorResponse, ValidationErrorResponse } from "../application";
import { Message } from "../message";
export declare function expectAuthErrorResponse(response: unknown, message?: string | RegExp): asserts response is AuthErrorResponse;
export declare function expectSystemErrorResponse(response: unknown, message?: string | RegExp): asserts response is SystemErrorResponse;
export declare function expectUnknownErrorResponse(response: unknown, message?: string | RegExp): asserts response is UnknownErrorResponse;
export declare function expectValidationErrorResponse(response: unknown, fields?: Record<string, "*" | string>): asserts response is ValidationErrorResponse;
export declare function expectMessagesToEqual(messages: Array<Message<any>>, expectedMessages: Array<Message<any>>): void;
export declare function expectMessagesToContain(events: Array<Message<any>>, expectedEvents: Array<Message<any>>): void;
//# sourceMappingURL=assertions.d.ts.map