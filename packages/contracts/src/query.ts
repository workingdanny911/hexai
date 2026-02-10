import { Message } from "@hexaijs/core";

export class Query<Payload = unknown, ResultType = unknown> extends Message<Payload> {
    declare readonly ResultType: ResultType;

    static override getIntent(): string {
        return "query";
    }
}
