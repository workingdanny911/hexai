import { ContractQuery } from "@hexaijs/contracts/decorators";
import {
    QueryBase,
    UsedProfile,
    buildProfileLabel,
    UnusedProfile,
} from "./profile-dependencies.js";
import type { TypeOnlyShape } from "./type-only-shape.js";

@ContractQuery()
export class GetProfileQuery extends QueryBase {
    readonly profile!: UsedProfile;
    readonly typeOnly!: TypeOnlyShape;

    static label(profile: UsedProfile): string {
        return buildProfileLabel(profile);
    }
}
