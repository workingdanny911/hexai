export interface PublicEventOptions {
  /**
   * Event version for versioned events
   * @example @PublicEvent({ version: 2 })
   */
  version?: number;

  /**
   * Business context this event belongs to.
   * If not specified, inferred from package name.
   * @example @PublicEvent({ context: 'lecture' })
   */
  context?: string;
}

export interface PublicCommandOptions {
  /**
   * Business context this command belongs to.
   * If not specified, inferred from package name.
   * @example @PublicCommand({ context: 'auth' })
   */
  context?: string;

  /**
   * Explicit response type name for this command.
   * If specified, the parser will look for this type in the same file.
   * @example @PublicCommand({ response: 'CreateUserResult' })
   */
  response?: string;
}

export interface PublicQueryOptions {
  /**
   * Business context this query belongs to.
   * If not specified, inferred from package name.
   * @example @PublicQuery({ context: 'catalog' })
   */
  context?: string;

  /**
   * Explicit response type name for this query.
   * If specified, the parser will look for this type in the same file.
   * @example @PublicQuery({ response: 'UserProfile' })
   */
  response?: string;
}

export function PublicEvent(_options: PublicEventOptions = {}): ClassDecorator {
  return (target) => target;
}

export function PublicCommand(
  _options: PublicCommandOptions = {}
): ClassDecorator {
  return (target) => target;
}

export function PublicQuery(_options: PublicQueryOptions = {}): ClassDecorator {
  return (target) => target;
}
