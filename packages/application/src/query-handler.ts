import { Query } from "@/query";

export interface QueryHandler<Q extends Query = Query, Ctx = any> {
    execute(query: Q, ctx?: Ctx): Promise<Q["ResultType"]>;
}
