import { PublicQuery } from "@hexaijs/plugin-contracts-generator";
import DefaultProfile from "./default-profile";
import * as Types from "./namespace-types";
import { AliasedUser as DomainUser } from "./aliased-user";
import MixedDefault, { MixedUserSource as MixedUser, UnusedUser } from "./mixed-user";
import type TypeOnlyDefault from "./type-only-default";

export function deriveImportShapeLabel(value: string): string {
    return `shape:${value}`;
}

interface ImportShapePayload {
    primary: DefaultProfile;
    namespaceUser: Types.User;
    nestedNamespaceUser: Types.Inner.User;
    owner: DomainUser;
    mixedDefault: MixedDefault;
    mixedUser: MixedUser;
    typeOnly: TypeOnlyDefault;
}

export interface ImportShapesQueryResult {
    payload: ImportShapePayload;
}

@PublicQuery()
export class ImportShapesQuery {
    public static type = "test.import-shapes";

    constructor(public readonly payload: ImportShapePayload) {}

    public label(): string {
        return deriveImportShapeLabel(this.payload.primary.id);
    }
}
