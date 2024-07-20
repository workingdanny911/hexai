export interface HandlerObject<Req = any, Res = any> {
    handle(request: Req): Res;
}

export type HandlerFunction<Req = any, Res = any> = (request: Req) => Res;

export type Handler<Req = any, Res = any> =
    | HandlerObject<Req, Res>
    | HandlerFunction<Req, Res>;

export type AnyHandler = Handler<any, any>;

export type RequestOf<H> = H extends Handler<infer Req, any> ? Req : never;

export type ResponseOf<H> = H extends Handler<any, infer Res> ? Res : never;

export type FindResponseByRequest<Handlers, Req> = Handlers extends [
    infer H,
    ...infer Rest,
]
    ? RequestOf<H> extends Req
        ? ResponseOf<H>
        : FindResponseByRequest<Rest, Req>
    : never;
