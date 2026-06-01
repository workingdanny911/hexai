export type MessageContractKind = "command" | "query" | "event";

export type BuiltInContractKind = MessageContractKind | "contract";

export type ContractKind = BuiltInContractKind | (string & {});

export type ContractVisibility = "public" | "internal";

export interface ContractBaseOptions {
  /**
   * Public contracts are emitted by default. Internal contracts require explicit opt-in.
   * @example @ContractCommand({ visibility: "internal" })
   */
  visibility?: ContractVisibility;

  /**
   * Auxiliary labels for downstream output selection.
   * Visibility remains the primary public/internal boundary.
   */
  tags?: readonly string[];

  /**
   * Business context this contract belongs to.
   * If not specified, inferred from package name.
   */
  context?: string;
}

export interface ContractOptions extends ContractBaseOptions {
  /**
   * Contract kind for generic contract markers.
   * Message-specific decorators provide this implicitly.
   * @example @Contract({ kind: "command" })
   */
  kind?: ContractKind;

  /**
   * Explicit response type name for generic command/query contracts.
   * If specified, the parser will look for this type in the same file.
   * @example @Contract({ kind: "query", response: "UserProfile" })
   */
  response?: string;

  /**
   * Event version for generic event contracts.
   * @example @Contract({ kind: "event", version: 2 })
   */
  version?: number;
}

export interface ContractEventOptions extends ContractBaseOptions {
  /**
   * Event version for versioned events
   * @example @ContractEvent({ version: 2 })
   */
  version?: number;
}

export interface ContractCommandOptions extends ContractBaseOptions {
  /**
   * Explicit response type name for this command.
   * If specified, the parser will look for this type in the same file.
   * @example @ContractCommand({ response: 'CreateUserResult' })
   */
  response?: string;
}

export interface ContractQueryOptions extends ContractBaseOptions {
  /**
   * Explicit response type name for this query.
   * If specified, the parser will look for this type in the same file.
   * @example @ContractQuery({ response: 'UserProfile' })
   */
  response?: string;
}

function noOpClassDecorator(): ClassDecorator {
  return (target) => target;
}

export function Contract(_options: ContractOptions = {}): ClassDecorator {
  return noOpClassDecorator();
}

export function ContractEvent(
  _options: ContractEventOptions = {}
): ClassDecorator {
  return noOpClassDecorator();
}

export function ContractCommand(
  _options: ContractCommandOptions = {}
): ClassDecorator {
  return noOpClassDecorator();
}

export function ContractQuery(
  _options: ContractQueryOptions = {}
): ClassDecorator {
  return noOpClassDecorator();
}

/** @deprecated Use ContractOptions instead. */
export type PublicContractOptions = ContractOptions;

/** @deprecated Use ContractEventOptions instead. */
export type PublicEventOptions = ContractEventOptions;

/** @deprecated Use ContractCommandOptions instead. */
export type PublicCommandOptions = ContractCommandOptions;

/** @deprecated Use ContractQueryOptions instead. */
export type PublicQueryOptions = ContractQueryOptions;

/** @deprecated Use Contract instead. */
export const PublicContract = Contract;

/** @deprecated Use ContractEvent instead. */
export const PublicEvent = ContractEvent;

/** @deprecated Use ContractCommand instead. */
export const PublicCommand = ContractCommand;

/** @deprecated Use ContractQuery instead. */
export const PublicQuery = ContractQuery;
