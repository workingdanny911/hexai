import { Query } from "@/query";

export interface QueryHandler<
    I extends Query = Query,
    O = any,
    Ctx = any,
> {
    execute(query: I, ctx?: Ctx): Promise<O>;
}
