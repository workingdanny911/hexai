/**
 * Decorators for marking Domain Events and Commands.
 * These decorators have no runtime effect - the Message Parser
 * statically analyzes source code to find and extract them.
 */
import "reflect-metadata";

export interface PublicEventOptions {
  /**
   * Event version for versioned events
   * @example @PublicEvent({ version: 2 })
   */
  version?: number;

  /**
   * Business context this event belongs to
   * If not specified, inferred from package name
   * @example @PublicEvent({ context: 'lecture' })
   */
  context?: string;
}

export interface PublicCommandOptions {
  /**
   * Business context this command belongs to
   * If not specified, inferred from package name
   * @example @PublicCommand({ context: 'auth' })
   */
  context?: string;

  /**
   * Explicit response type name for this command
   * If specified, the parser will look for this type in the same file
   * @example @PublicCommand({ response: 'CreateUserResult' })
   */
  response?: string;
}


export interface PublicQueryOptions {
  /**
   * Business context this query belongs to
   * If not specified, inferred from package name
   * @example @PublicQuery({ context: 'catalog' })
   */
  context?: string;

  /**
   * Explicit response type name for this query
   * If specified, the parser will look for this type in the same file
   * @example @PublicQuery({ response: 'UserProfile' })
   */
  response?: string;
}

export const PUBLIC_EVENT_METADATA = Symbol('publicEvent');
export const PUBLIC_COMMAND_METADATA = Symbol('publicCommand');
export const PUBLIC_QUERY_METADATA = Symbol('publicQuery');

/**
 * Marks a class as a Domain Event for extraction to public contracts
 *
 * @example
 * ```typescript
 * @PublicEvent()
 * export class UserRegistered extends Message {
 *   constructor(
 *     public readonly userId: string,
 *     public readonly email: string,
 *   ) {
 *     super();
 *   }
 * }
 * ```
 *
 * @example With options
 * ```typescript
 * @PublicEvent({ version: 2, context: 'auth' })
 * export class UserRegisteredV2 extends Message {
 *   // ...
 * }
 * ```
 */
export function PublicEvent(options: PublicEventOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(PUBLIC_EVENT_METADATA, options, target);
    return target;
  };
}

/**
 * Marks a class as a Command for extraction to public contracts
 *
 * @example
 * ```typescript
 * @PublicCommand()
 * export class CreateUser extends Request<CreateUserResult> {
 *   constructor(
 *     public readonly email: string,
 *     public readonly name: string,
 *   ) {
 *     super();
 *   }
 * }
 * ```
 *
 * @example With context option
 * ```typescript
 * @PublicCommand({ context: 'auth' })
 * export class CreateUser extends Request<CreateUserResult> {
 *   // ...
 * }
 * ```
 *
 * @example With explicit response type
 * ```typescript
 * @PublicCommand({ response: 'DialogueCreatedResult' })
 * export class BeginDialogueRequest extends Request<DialogueCreatedResult> {
 *   // ...
 * }
 * export type DialogueCreatedResult = { dialogueId: string };
 * ```
 */
export function PublicCommand(options: PublicCommandOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(PUBLIC_COMMAND_METADATA, options, target);
    return target;
  };
}


/**
 * Marks a class as a Query for extraction to public contracts
 *
 * @example
 * ```typescript
 * @PublicQuery()
 * export class GetUserProfile extends Request<UserProfile> {
 *   constructor(
 *     public readonly userId: string,
 *   ) {
 *     super();
 *   }
 * }
 * ```
 *
 * @example With context option
 * ```typescript
 * @PublicQuery({ context: 'catalog' })
 * export class GetProductDetails extends Request<ProductDetails> {
 *   // ...
 * }
 * ```
 *
 * @example With explicit response type
 * ```typescript
 * @PublicQuery({ response: 'UserProfileResult' })
 * export class GetUserProfile extends Request<UserProfileResult> {
 *   // ...
 * }
 * export type UserProfileResult = { name: string; email: string };
 * ```
 */
export function PublicQuery(options: PublicQueryOptions = {}): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(PUBLIC_QUERY_METADATA, options, target);
    return target;
  };
}
