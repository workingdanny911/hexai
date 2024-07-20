import { Handler } from "./handler";
import { HandlerRegistry } from "./handler-registry";

interface RequestWithType {
    type: string;
}

export class SimpleHandlerRegistry
    implements HandlerRegistry<string, RequestWithType>
{
    private handlers: Record<string, Handler> = {};

    register(requestType: string, handler: Handler) {
        this.handlers[requestType] = handler;
    }

    getByRequest(request: any) {
        return this.handlers[request.type];
    }
}
