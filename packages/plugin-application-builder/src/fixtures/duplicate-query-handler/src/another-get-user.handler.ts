import { QueryHandlerMarker } from "@hexaijs/plugin-application-builder";
import { GetUserQuery } from "./get-user.query";

@QueryHandlerMarker(GetUserQuery)
export class AnotherGetUserHandler {
    async execute(query: GetUserQuery): Promise<{ id: string; name: string }> {
        return { id: query.getPayload().userId, name: "Jane Doe" };
    }
}
