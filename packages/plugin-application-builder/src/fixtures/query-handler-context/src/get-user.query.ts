import { Query } from "@hexaijs/application";

export class GetUserQuery extends Query<{ userId: string }, { role: string }> {
    constructor(
        payload: { userId: string },
        securityContext?: { role: string }
    ) {
        super(payload, { securityContext });
    }
}
