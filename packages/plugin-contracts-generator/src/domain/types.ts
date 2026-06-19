export interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly packageName?: string;
}

export type TypeRef =
  | PrimitiveType
  | ArrayType
  | ObjectType
  | UnionType
  | IntersectionType
  | ReferenceType
  | LiteralType
  | TupleType
  | FunctionType;

export interface PrimitiveType {
  readonly kind: 'primitive';
  readonly name:
    | 'string'
    | 'number'
    | 'boolean'
    | 'null'
    | 'undefined'
    | 'void'
    | 'any'
    | 'unknown'
    | 'never'
    | 'bigint'
    | 'symbol';
}

export interface ArrayType {
  readonly kind: 'array';
  readonly elementType: TypeRef;
}

export interface ObjectType {
  readonly kind: 'object';
  readonly fields: readonly Field[];
}

export interface UnionType {
  readonly kind: 'union';
  readonly types: readonly TypeRef[];
}

export interface IntersectionType {
  readonly kind: 'intersection';
  readonly types: readonly TypeRef[];
}

export interface ReferenceType {
  readonly kind: 'reference';
  readonly name: string;
  readonly typeArguments?: readonly TypeRef[];
}

export interface LiteralType {
  readonly kind: 'literal';
  readonly value: string | number | boolean;
}

export interface TupleType {
  readonly kind: 'tuple';
  readonly elements: readonly TypeRef[];
}

export interface FunctionType {
  readonly kind: 'function';
  readonly parameters: readonly FunctionParameter[];
  readonly returnType: TypeRef;
}

export interface FunctionParameter {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
}

export interface Field {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
  readonly readonly: boolean;
}

export type TypeDefinitionKind = 'interface' | 'type' | 'enum' | 'class';

export interface TypeDefinition {
  readonly name: string;
  readonly kind: TypeDefinitionKind;
  readonly sourceFile: SourceFile;
  readonly body: TypeRef;
  readonly typeParameters?: readonly string[];
  readonly exported: boolean;
}

export interface EnumMember {
  readonly name: string;
  readonly value?: string | number;
}

export interface EnumDefinition extends Omit<TypeDefinition, 'kind' | 'body'> {
  readonly kind: 'enum';
  readonly members: readonly EnumMember[];
}

export interface ClassImport {
  readonly names: readonly string[];
  readonly source: string;
  readonly isTypeOnly: boolean;
  readonly isExternal: boolean;
}

export interface ClassDefinition {
  readonly name: string;
  readonly kind: 'class';
  readonly sourceFile: SourceFile;
  readonly sourceText: string;
  readonly imports: readonly ClassImport[];
  readonly dependencies: readonly string[];
  readonly baseClass?: string;
  readonly exported: boolean;
}

export type MessageContractKind = 'command' | 'query' | 'event';

export type BuiltInContractKind = MessageContractKind | 'contract';

export type ContractKind = BuiltInContractKind | (string & {});

export type ContractVisibility = 'public' | 'internal';

export type ContractMarkerSyntax = 'decorator' | 'comment';

export interface ContractMarkerMetadata {
  readonly syntax: ContractMarkerSyntax;
  readonly name: string;
  readonly canonicalName: string;
  readonly kind?: ContractKind;
  readonly visibility: ContractVisibility;
  readonly tags: readonly string[];
  readonly legacy: boolean;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly importedName?: string;
  readonly localName?: string;
  readonly moduleSpecifier?: string;
}

export interface ContractDeclarationBase {
  readonly name: string;
  readonly contractType: 'message' | 'contract';
  readonly kind: ContractKind;
  readonly visibility: ContractVisibility;
  readonly tags: readonly string[];
  readonly marker: ContractMarkerMetadata;
  readonly sourceFile: SourceFile;
  readonly exported: boolean;
}

export type PublicContractDeclarationKind = 'class' | 'interface' | 'type' | 'enum';

export interface PublicContract {
  readonly name: string;
  readonly contractType: 'contract';
  readonly declarationKind: PublicContractDeclarationKind;
  readonly sourceFile: SourceFile;
  readonly exported: boolean;
  readonly kind?: ContractKind;
  readonly visibility?: ContractVisibility;
  readonly tags?: readonly string[];
  readonly marker?: ContractMarkerMetadata;
}

export interface MessageBase {
  readonly name: string;
  readonly sourceFile: SourceFile;
  readonly fields: readonly Field[];
  readonly baseClass?: string;
  readonly sourceText: string;
  readonly imports: readonly ClassImport[];
  readonly kind?: MessageContractKind;
  readonly visibility?: ContractVisibility;
  readonly tags?: readonly string[];
  readonly marker?: ContractMarkerMetadata;
}

export interface DomainEvent extends MessageBase {
  readonly messageType: 'event';
  readonly version?: number;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

export interface Command extends MessageBase {
  readonly messageType: 'command';
  readonly resultType?: TypeRef;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

export interface Query extends MessageBase {
  readonly messageType: 'query';
  readonly resultType?: TypeRef;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

export type Message = DomainEvent | Command | Query;

/** Used to filter which decorators the scanner should look for. */
export type MessageType = Message['messageType'];

export function isMessageContractKind(
  kind: unknown
): kind is MessageContractKind {
  return kind === 'command' || kind === 'query' || kind === 'event';
}

export function toMessageType(kind: unknown): MessageType | undefined {
  return isMessageContractKind(kind) ? kind : undefined;
}

export interface ContractEventDeclaration
  extends ContractDeclarationBase,
    Omit<DomainEvent, 'kind' | 'visibility' | 'tags' | 'marker'> {
  readonly contractType: 'message';
  readonly kind: 'event';
  readonly marker: ContractMarkerMetadata;
}

export interface ContractCommandDeclaration
  extends ContractDeclarationBase,
    Omit<Command, 'kind' | 'visibility' | 'tags' | 'marker'> {
  readonly contractType: 'message';
  readonly kind: 'command';
  readonly marker: ContractMarkerMetadata;
}

export interface ContractQueryDeclaration
  extends ContractDeclarationBase,
    Omit<Query, 'kind' | 'visibility' | 'tags' | 'marker'> {
  readonly contractType: 'message';
  readonly kind: 'query';
  readonly marker: ContractMarkerMetadata;
}

export type ContractMessageDeclaration =
  | ContractEventDeclaration
  | ContractCommandDeclaration
  | ContractQueryDeclaration;

export interface GeneralContractDeclaration extends ContractDeclarationBase {
  readonly contractType: 'contract';
  readonly declarationKind: PublicContractDeclarationKind;
}

export type ContractDeclaration =
  | ContractMessageDeclaration
  | GeneralContractDeclaration;

export type EntryStrategy = 'graph' | 'symbols';

export type OutputModuleSpecifiers = 'js' | 'extensionless';

export type ContractOutputInclude = 'all' | 'messages' | 'contracts';

export interface ContractOutputTagSelect {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ContractOutputSelect {
  readonly visibility?: readonly ContractVisibility[];
  readonly kinds?: readonly ContractKind[];
  readonly messageKinds?: readonly MessageContractKind[];
  readonly include?: ContractOutputInclude;
  readonly tags?: ContractOutputTagSelect;
}

export interface ContractOutputConfig {
  readonly name: string;
  readonly path: string;
  readonly select?: ContractOutputSelect;
  readonly registry?: boolean;
  readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
}

export type TrustedDecoratorSources = readonly string[];

export const VALID_ENTRY_STRATEGIES: readonly EntryStrategy[] = [
  'graph',
  'symbols',
];

export const VALID_OUTPUT_MODULE_SPECIFIERS: readonly OutputModuleSpecifiers[] = [
  'js',
  'extensionless',
];

export function isEntryStrategy(value: unknown): value is EntryStrategy {
  return (
    typeof value === 'string' &&
    VALID_ENTRY_STRATEGIES.includes(value as EntryStrategy)
  );
}

export function isOutputModuleSpecifiers(
  value: unknown
): value is OutputModuleSpecifiers {
  return (
    typeof value === 'string' &&
    VALID_OUTPUT_MODULE_SPECIFIERS.includes(value as OutputModuleSpecifiers)
  );
}

export type ImportSource =
  | { readonly type: 'local'; readonly path: string }
  | { readonly type: 'external'; readonly package: string };

export type DependencyKind = 'type' | 'value' | 'class';

export interface Dependency {
  readonly name: string;
  readonly source: ImportSource;
  readonly kind: DependencyKind;
  readonly definition?: TypeDefinition;
}

export interface SourceLocation {
  readonly file: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type ExtractionError = SourceLocation;
export type ExtractionWarning = SourceLocation;

export interface ExtractionResult {
  readonly events: readonly DomainEvent[];
  readonly commands: readonly Command[];
  readonly queries: readonly Query[];
  readonly publicContracts: readonly PublicContract[];
  readonly types: readonly TypeDefinition[];
  readonly dependencies: readonly Dependency[];
  readonly errors: readonly ExtractionError[];
  readonly warnings: readonly ExtractionWarning[];
}

/** Customizes decorator names used to identify public messages. Unspecified names use defaults. */
export interface DecoratorNames {
  event?: string;
  command?: string;
  query?: string;
}

export const DEFAULT_DECORATOR_NAMES: Required<DecoratorNames> = {
  event: "PublicEvent",
  command: "PublicCommand",
  query: "PublicQuery",
};

/** Merges partial decorator names with defaults for backward compatibility. */
export function mergeDecoratorNames(partial?: DecoratorNames): Required<DecoratorNames> {
  return {
    ...DEFAULT_DECORATOR_NAMES,
    ...partial,
  };
}

/** Customizes comment marker names used to identify public non-message contracts. */
export interface ContractMarkerNames {
  contract?: string;
}

export const DEFAULT_CONTRACT_MARKER_NAMES: Required<ContractMarkerNames> = {
  contract: "PublicContract",
};

/** Merges partial contract marker names with defaults for backward compatibility. */
export function mergeContractMarkerNames(
  partial?: ContractMarkerNames
): Required<ContractMarkerNames> {
  return {
    ...DEFAULT_CONTRACT_MARKER_NAMES,
    ...partial,
  };
}

export interface ResponseNamingConvention {
  readonly messageSuffix: string;
  readonly responseSuffix: string;
}

export interface Config {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly externalPackages?: Readonly<Record<string, string>>;
  readonly decoratorNames?: DecoratorNames;
  readonly trustedDecoratorSources?: TrustedDecoratorSources;
  readonly entryStrategy?: EntryStrategy;
  readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
  readonly responseNamingConventions?: readonly ResponseNamingConvention[];
}

export function isPrimitiveType(type: TypeRef): type is PrimitiveType {
  return type.kind === 'primitive';
}

export function isArrayType(type: TypeRef): type is ArrayType {
  return type.kind === 'array';
}

export function isObjectType(type: TypeRef): type is ObjectType {
  return type.kind === 'object';
}

export function isUnionType(type: TypeRef): type is UnionType {
  return type.kind === 'union';
}

export function isIntersectionType(type: TypeRef): type is IntersectionType {
  return type.kind === 'intersection';
}

export function isReferenceType(type: TypeRef): type is ReferenceType {
  return type.kind === 'reference';
}

export function isLiteralType(type: TypeRef): type is LiteralType {
  return type.kind === 'literal';
}

export function isTupleType(type: TypeRef): type is TupleType {
  return type.kind === 'tuple';
}

export function isFunctionType(type: TypeRef): type is FunctionType {
  return type.kind === 'function';
}

export function isDomainEvent(message: Message): message is DomainEvent {
  return message.messageType === 'event';
}

export function isCommand(message: Message): message is Command {
  return message.messageType === 'command';
}

export function isQuery(message: Message): message is Query {
  return message.messageType === 'query';
}
