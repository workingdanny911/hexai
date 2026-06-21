import { formatProfileId, unusedFormat } from "./transitive-formatters.js";

interface ProfileMetadata {
    readonly prefix: string;
}

const localPrefix = "profile";

export abstract class QueryBase {
    readonly queryId = formatProfileId("root");
}

export interface UsedProfile extends ProfileMetadata {
    readonly id: string;
}

export function buildProfileLabel(profile: UsedProfile): string {
    return localPrefix + ":" + formatProfileId(profile.id);
}

export interface UnusedProfile {
    readonly id: string;
}

export function unusedProfileLabel(profile: UnusedProfile): string {
    return unusedFormat(profile.id);
}
