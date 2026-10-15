# Domain Model

This guide describes the data the contracts generator builds while it reads source code. It is for contributors. To use the generator, read the [README](../README.md); for the modules that build and consume this data, read the [architecture guide](./ARCHITECTURE.md).

All types live in `src/domain/types.ts`. The package root exports most of them. `ContractMarkerMetadata`, `ContractMarkerSyntax`, `ContractDeclarationBase`, the `Contract*Declaration` variants, `GeneralContractDeclaration`, `SourceLocation` and `ResponseNamingConvention` stay internal. The kind and visibility types (`ContractKind`, `ContractVisibility` and others) are exported from the root too, but as re-exports of the identical types in `@hexaijs/contracts/decorators`.

## Contents

1. [Overview](#1-overview)
2. [Contract markers](#2-contract-markers)
3. [Contract declarations](#3-contract-declarations)
4. [Messages](#4-messages)
5. [General contracts](#5-general-contracts)
6. [Type model](#6-type-model)
7. [Configuration values](#7-configuration-values)
8. [Results](#8-results)
9. [Exported types the pipeline does not produce](#9-exported-types-the-pipeline-does-not-produce)
10. [Worked example](#10-worked-example)

## 1. Overview

`Parser.parse()` turns one entry file into a `ParseResult`:

```text
entry file ──Parser──> ParseResult
                       ├── events, commands, queries   message views (DomainEvent, Command, Query)
                       ├── publicContracts             general contract view (PublicContract)
                       ├── contractDeclarations        canonical view (ContractDeclaration)
                       └── typeDefinitions             every type alias and interface in the file
```

The model is metadata. The pipeline uses it to select contracts, find response types, decide which declarations need an added `export`, build the registry and report counts. The copied code itself comes from the source text: `FileCopier` re-reads each file's syntax tree and emits the selected declarations (see [File copier](./ARCHITECTURE.md#9-file-copier)).

`ContractsPipeline` consumes the message views, `publicContracts` and `typeDefinitions`. It does not read `contractDeclarations` yet.

## 2. Contract markers

A marker is the decorator or comment that marks a contract (see [Marking contracts](../README.md#marking-contracts)). `ContractDecoratorMatcher` turns every recognized marker into `ContractMarkerMetadata`:

```typescript
type MessageContractKind = 'command' | 'query' | 'event';
type BuiltInContractKind = MessageContractKind | 'contract';
type ContractKind = BuiltInContractKind | (string & {});
type ContractVisibility = 'public' | 'internal';
type ContractMarkerSyntax = 'decorator' | 'comment';

interface ContractMarkerMetadata {
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
```

| Field | Value |
|-------|-------|
| `syntax` | `'decorator'` or `'comment'`. |
| `name` | The name as written in the source: the local alias for an aliased import, the marker name for a comment. |
| `canonicalName` | `Contract`, `ContractCommand`, `ContractQuery` or `ContractEvent`. Legacy names map to these. |
| `kind` | For `Contract`, the `kind` option (default `'contract'`). For the message decorators, their fixed kind. |
| `visibility` | `'internal'` only when the `visibility` option is the literal `"internal"`; `'public'` otherwise. |
| `tags` | The string entries of the `tags` option. |
| `legacy` | `true` for `Public*` names and names configured through `decoratorNames` or `contractMarkerNames`. |
| `options` | The literal options: strings, numbers, booleans and arrays of them. Other expressions become `undefined`. |
| `importedName`, `localName`, `moduleSpecifier` | The import binding of a decorator. Absent for comment markers and for legacy decorators without an import. |

## 3. Contract declarations

`ContractDeclaration` is the canonical model for everything the generator can select. It is a union of three message declarations and one general declaration:

```text
                      ContractDeclarationBase
                 name, contractType, kind, visibility,
                 tags, marker, sourceFile, exported
                                │
           ┌────────────────────┴────────────────────┐
           ▼                                         ▼
ContractMessageDeclaration                GeneralContractDeclaration
  contractType: 'message'                   contractType: 'contract'
  kind: 'event' | 'command' | 'query'       kind: any non-message kind
  plus the message fields (section 4)       declarationKind: 'class' | 'interface'
                                                           | 'type' | 'enum'
```

```typescript
interface ContractDeclarationBase {
  readonly name: string;
  readonly contractType: 'message' | 'contract';
  readonly kind: ContractKind;
  readonly visibility: ContractVisibility;
  readonly tags: readonly string[];
  readonly marker: ContractMarkerMetadata;
  readonly sourceFile: SourceFile;
  readonly exported: boolean;
}

type ContractMessageDeclaration =
  | ContractEventDeclaration      // DomainEvent fields, kind: 'event'
  | ContractCommandDeclaration    // Command fields, kind: 'command'
  | ContractQueryDeclaration;     // Query fields, kind: 'query'

interface GeneralContractDeclaration extends ContractDeclarationBase {
  readonly contractType: 'contract';
  readonly declarationKind: PublicContractDeclarationKind;
}

type ContractDeclaration = ContractMessageDeclaration | GeneralContractDeclaration;
```

`visibility` is the boundary between outputs; `tags` are auxiliary filters only. Message declarations in `ParseResult.contractDeclarations` do not set `exported`, although the type declares it.

## 4. Messages

A message is a command, query or event class marked with a decorator. The message views predate `ContractDeclaration` and are what the pipeline, `processContext()` and `RegistryGenerator` use.

```typescript
interface MessageBase {
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

interface DomainEvent extends MessageBase {
  readonly messageType: 'event';
  readonly version?: number;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

interface Command extends MessageBase {
  readonly messageType: 'command';
  readonly resultType?: TypeRef;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

interface Query extends MessageBase {
  readonly messageType: 'query';
  readonly resultType?: TypeRef;
  readonly context?: string;
  readonly payloadType?: TypeRef;
}

type Message = DomainEvent | Command | Query;
type MessageType = Message['messageType'];

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;   // relative to the context's sourceDir
  readonly packageName?: string;   // never set by the pipeline
}

interface ClassImport {
  readonly names: readonly string[];
  readonly source: string;
  readonly isTypeOnly: boolean;
  readonly isExternal: boolean;    // true when source does not start with "."
}
```

How `Parser` fills each field:

| Field | Source |
|-------|--------|
| `name` | The class name. |
| `fields`, `payloadType` | The first type argument of the first `extends` type that has type arguments. A type literal gives `fields`. An intersection gives `payloadType` and the fields of its object members. A named type gives `payloadType` and no `fields`. |
| `baseClass` | The identifier after `extends`. |
| `sourceText` | The class text, including leading comments and decorators. |
| `imports` | Every import in the file that binds a default or named import. Namespace imports are not listed. |
| `kind`, `visibility`, `tags`, `marker` | The matched marker. The parse result objects also carry `contractType: 'message'`. |
| `version` | The `version` option of an event marker. |
| `context` | The `context` option. Neither `version` nor `context` affects generated files. |
| `resultType` | A reference to the `response` option's type name, or, when that is absent, to the first same-file type alias or interface that matches a `ResponseNamingConvention`. |

Type guards: `isDomainEvent()`, `isCommand()` and `isQuery()` narrow a `Message` by `messageType`.

A class with a comment marker of a message kind is not a message, and is not a general contract either; the parser ignores it.

## 5. General contracts

A general contract is any marked declaration that is not a message: read models, DTOs, value objects. `PublicContract` is its view in `ParseResult.publicContracts` and in pipeline results:

```typescript
type PublicContractDeclarationKind = 'class' | 'interface' | 'type' | 'enum';

interface PublicContract {
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
```

- A class qualifies through a `Contract` decorator with a non-message kind, or through a comment marker.
- An interface, type alias or enum qualifies only through a comment marker.
- `exported` records whether the source declaration has `export`. The pipeline collects unexported ones, and `FileCopier` adds `export` in the output.
- The parser always sets `kind`, `visibility`, `tags` and `marker`; they are optional in the type for compatibility.
- General contracts never reach `RegistryGenerator`.

## 6. Type model

`TypeRef` describes a type found in a payload, a field or a type alias. `kind` discriminates the variants:

| `kind` | Shape | `parseTypeNode()` produces it for |
|--------|-------|-----------------------------------|
| `'primitive'` | `{ name: 'string' \| 'number' \| 'boolean' \| 'null' \| 'undefined' \| 'void' \| 'any' \| 'unknown' \| 'never' \| 'bigint' \| 'symbol' }` | `string`, `number` and `boolean` only. A property without a type annotation gets `any`. |
| `'array'` | `{ elementType: TypeRef }` | `T[]` |
| `'object'` | `{ fields: readonly Field[] }` | type literals such as `{ a: T }` |
| `'union'` | `{ types: readonly TypeRef[] }` | `A \| B` |
| `'intersection'` | `{ types: readonly TypeRef[] }` | `A & B` |
| `'reference'` | `{ name: string; typeArguments?: readonly TypeRef[] }` | type references such as `UserId` or `Array<T>` (name `Array`), and every other type node as a fallback, with the source text as `name` (`"placed"`, `unknown`, `[A, B]`) |
| `'literal'` | `{ value: string \| number \| boolean }` | nothing yet |
| `'tuple'` | `{ elements: readonly TypeRef[] }` | nothing yet |
| `'function'` | `{ parameters: readonly FunctionParameter[]; returnType: TypeRef }` | nothing yet |

```typescript
interface Field {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
  readonly readonly: boolean;
}

interface FunctionParameter {
  readonly name: string;
  readonly type: TypeRef;
  readonly optional: boolean;
}

type TypeDefinitionKind = 'interface' | 'type' | 'enum' | 'class';

interface TypeDefinition {
  readonly name: string;
  readonly kind: TypeDefinitionKind;
  readonly sourceFile: SourceFile;
  readonly body: TypeRef;
  readonly typeParameters?: readonly string[];
  readonly exported: boolean;
}
```

Type guards: `isPrimitiveType()`, `isArrayType()`, `isObjectType()`, `isUnionType()`, `isIntersectionType()`, `isReferenceType()`, `isLiteralType()`, `isTupleType()` and `isFunctionType()`.

The parser records a `TypeDefinition` for every type alias (`kind: 'type'`) and interface (`kind: 'interface'`) in an entry file. It produces no `'enum'` or `'class'` definitions. The pipeline uses these definitions to match response types by name and to find response types that are not exported.

## 7. Configuration values

These types carry configuration into the pipeline. The [README configuration section](../README.md#configuration) describes what each option does.

```typescript
interface DecoratorNames {       // legacy message decorator names
  event?: string;                // default "PublicEvent"
  command?: string;              // default "PublicCommand"
  query?: string;                // default "PublicQuery"
}

interface ContractMarkerNames {  // legacy general contract marker name
  contract?: string;             // default "PublicContract"
}

type TrustedDecoratorSources = readonly string[];
type DependencyStrategy = 'file' | 'safe-symbols';
type OutputModuleSpecifiers = 'js' | 'extensionless';

interface ResponseNamingConvention {
  readonly messageSuffix: string;   // "Query" ...
  readonly responseSuffix: string;  // ... "QueryResult": GetOrderQuery -> GetOrderQueryResult
}

type ContractOutputInclude = 'all' | 'messages' | 'contracts';

interface ContractOutputTagSelect {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
}

interface ContractOutputSelect {
  readonly visibility?: readonly ContractVisibility[];
  readonly kinds?: readonly ContractKind[];
  readonly messageKinds?: readonly MessageContractKind[];
  readonly include?: ContractOutputInclude;
  readonly tags?: ContractOutputTagSelect;
}

interface ContractOutputConfig {
  readonly name: string;
  readonly path: string;
  readonly select?: ContractOutputSelect;
  readonly registry?: boolean;
  readonly outputModuleSpecifiers?: OutputModuleSpecifiers;
}
```

`mergeDecoratorNames()` and `mergeContractMarkerNames()` fill the legacy defaults (`DEFAULT_DECORATOR_NAMES`, `DEFAULT_CONTRACT_MARKER_NAMES`). Configured names replace the defaults; they do not add to them.

`isContractSelected()` in `src/contract-selector.ts` applies a `ContractOutputSelect` to one contract. It treats a missing `kind` as the message type or `'contract'`, a missing `visibility` as `'public'` and missing `tags` as empty, and requires every set field to match. `hasStrictOutputSelection()` is `true` when any field is set; only then does `FileCopier` run the boundary check.

## 8. Results

```typescript
interface ParseResult {                       // Parser.parse(), one file
  readonly events: readonly DomainEvent[];
  readonly commands: readonly Command[];
  readonly queries: readonly Query[];
  readonly publicContracts: readonly PublicContract[];
  readonly contractDeclarations: readonly ContractDeclaration[];
  readonly typeDefinitions: readonly TypeDefinition[];
}

interface ParsedMessages {                    // ContractsPipeline.parse(), all entry files
  readonly events: readonly DomainEvent[];
  readonly commands: readonly Command[];
  readonly queries: readonly Query[];
  readonly publicContracts: readonly PublicContract[];
  readonly typeDefinitions: readonly TypeDefinition[];
}

interface PipelineResult {                    // ContractsPipeline.execute(), selected contracts
  readonly events: readonly DomainEvent[];
  readonly commands: readonly Command[];
  readonly queries: readonly Query[];
  readonly publicContracts: readonly PublicContract[];
  readonly copiedFiles: string[];             // written files, joined onto the given outputDir
}

interface ProcessContextResult {              // processContext(), same content as PipelineResult
  events: readonly DomainEvent[];
  commands: readonly Command[];
  queries: readonly Query[];
  publicContracts: readonly PublicContract[];
  copiedFiles: string[];
}
```

`PipelineResult` lists the contracts after output selection. `copiedFiles` lists every written file except the context `index.ts`.

## 9. Exported types the pipeline does not produce

The package root still exports these types for compatibility. No pipeline stage creates them; do not build new features on them without first giving them a producer.

| Type | Describes |
|------|-----------|
| `ClassDefinition` | A class with its source text, imports, referenced names and base class. Only test helpers build it. |
| `EnumDefinition`, `EnumMember` | An enum and its members. |
| `Dependency`, `DependencyKind`, `ImportSource` | A resolved import of a contract. `FileGraphResolver` models imports as `ImportInfo` instead. |
| `ExtractionResult`, `ExtractionError`, `ExtractionWarning` | An earlier result shape with errors and warnings. Errors are now thrown (see [Errors](../README.md#errors)). |
| `Config` | An earlier configuration shape. Configuration now arrives as `ContractsConfig` and `ProcessContextOptions`. |

## 10. Worked example

Input, in a context named `orders` whose source directory is `packages/orders/src`:

```typescript
// messages/place-order.ts
import { Command } from "@hexaijs/contracts";
import { ContractCommand } from "@hexaijs/contracts/decorators";

import type { Money } from "../domain/money.js";

@ContractCommand({ response: "PlaceOrderResult" })
export class PlaceOrderCommand extends Command<
    { customerId: string; total: Money },
    PlaceOrderResult
> {
    static readonly type = "orders.place-order";
}

type PlaceOrderResult = {
    orderId: string;
};

export class PlaceOrderHandler {}
```

```typescript
// domain/money.ts
export type Currency = "KRW" | "USD";

export interface Money {
    amount: number;
    currency: Currency;
}

export function formatMoney(money: Money): string {
    return `${money.amount} ${money.currency}`;
}
```

`Parser.parse()` on `messages/place-order.ts` returns one command (`sourceText` omitted):

```typescript
{
  name: "PlaceOrderCommand",
  messageType: "command",
  contractType: "message",
  kind: "command",
  visibility: "public",
  tags: [],
  sourceFile: {
    absolutePath: "/repo/packages/orders/src/messages/place-order.ts",
    relativePath: "messages/place-order.ts",
  },
  baseClass: "Command",
  fields: [
    { name: "customerId", type: { kind: "primitive", name: "string" }, optional: false, readonly: false },
    { name: "total", type: { kind: "reference", name: "Money" }, optional: false, readonly: false },
  ],
  resultType: { kind: "reference", name: "PlaceOrderResult" },
  imports: [
    { names: ["Command"], source: "@hexaijs/contracts", isTypeOnly: false, isExternal: true },
    { names: ["ContractCommand"], source: "@hexaijs/contracts/decorators", isTypeOnly: false, isExternal: true },
    { names: ["Money"], source: "../domain/money.js", isTypeOnly: true, isExternal: false },
  ],
  marker: {
    syntax: "decorator",
    name: "ContractCommand",
    canonicalName: "ContractCommand",
    kind: "command",
    visibility: "public",
    tags: [],
    legacy: false,
    options: { response: "PlaceOrderResult" },
    importedName: "ContractCommand",
    localName: "ContractCommand",
    moduleSpecifier: "@hexaijs/contracts/decorators",
  },
}
```

and one type definition:

```typescript
{
  name: "PlaceOrderResult",
  kind: "type",
  sourceFile: { absolutePath: "/repo/packages/orders/src/messages/place-order.ts", relativePath: "messages/place-order.ts" },
  body: {
    kind: "object",
    fields: [{ name: "orderId", type: { kind: "primitive", name: "string" }, optional: false, readonly: false }],
  },
  exported: false,
}
```

From this model the pipeline knows that `PlaceOrderResult` is the response type and is not exported. `FileCopier` then prints the selected declarations, slices `money.ts` down to the declarations `Money` needs, and writes (with `removeDecorators: true`):

```typescript
// <output>/orders/messages/place-order.ts
import { Command } from "@hexaijs/contracts";
import type { Money } from "../domain/money.js";
export type PlaceOrderResult = {
    orderId: string;
};
export class PlaceOrderCommand extends Command<{
    customerId: string;
    total: Money;
}, PlaceOrderResult> {
    static readonly type = "orders.place-order";
}
```

```typescript
// <output>/orders/domain/money.ts
export type Currency = "KRW" | "USD";
export interface Money {
    amount: number;
    currency: Currency;
}
```

A general contract looks like this. For

```typescript
// read-models/order-summary.ts
// @Contract({ kind: "read-model", tags: ["frontend"] })
interface OrderSummary {
    orderId: string;
    itemCount: number;
}
```

the parser returns this `PublicContract` (and a `TypeDefinition` for the interface):

```typescript
{
  name: "OrderSummary",
  contractType: "contract",
  declarationKind: "interface",
  kind: "read-model",
  visibility: "public",
  tags: ["frontend"],
  exported: false,
  sourceFile: {
    absolutePath: "/repo/packages/orders/src/read-models/order-summary.ts",
    relativePath: "read-models/order-summary.ts",
  },
  marker: {
    syntax: "comment",
    name: "Contract",
    canonicalName: "Contract",
    kind: "read-model",
    visibility: "public",
    tags: ["frontend"],
    legacy: false,
    options: { kind: "read-model", tags: ["frontend"] },
  },
}
```

The output is `export interface OrderSummary { ... }`, without the marker comment.
