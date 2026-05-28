// @PublicContract()
interface PublicProfile {
    id: PublicUserId;
    email: string;
}

interface InternalProfileRecord {
    secretToken: string;
}

/**
 * @PublicContract()
 */
type PublicUserId = string;

// @PublicContract()
class PublicProjection {
    constructor(readonly id: PublicUserId) {}
}

/**
 * Public statuses shared with clients.
 *
 * @PublicContract()
 */
enum PublicStatus {
    Active = "active",
    Disabled = "disabled",
}

class InternalProjection {
    constructor(readonly record: InternalProfileRecord) {}
}
