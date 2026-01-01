import { PublicQuery } from "@hexaijs/plugin-contracts-generator";
import { BaseProfile, generateId, formatDate } from "./base-types";

// Local interface that extends an imported type
// This tests ExpressionWithTypeArguments dependency extraction
interface ExtendedProfile extends BaseProfile {
    email: string;
    phoneNumber: string;
}

// Query result uses the extended local interface
export interface GetProfileQueryResult {
    profile: ExtendedProfile;
    lastUpdated: string;
}

@PublicQuery()
export class GetProfileQuery {
    public static type = "test.get-profile";

    constructor(public readonly profileId: string) {}

    // Static factory method that calls imported functions
    // This tests CallExpression dependency extraction
    public static create(prefix: string, date: Date): GetProfileQuery {
        const id = generateId(prefix);
        const formatted = formatDate(date);
        console.log(`Created at ${formatted}`);
        return new GetProfileQuery(id);
    }
}
