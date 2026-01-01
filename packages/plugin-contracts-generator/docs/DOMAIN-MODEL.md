# Domain Model

Defines the core domain model for the Contracts Generator.

## Core Concepts

### 1. Message (Extraction Target)

Message is a data structure used for inter-system communication.

```
┌─────────────────────────────────────────────────────────────┐
│                      MessageBase                            │
├─────────────────────────────────────────────────────────────┤
│ - name: string              // Class name                   │
│ - sourceFile: SourceFile    // Original file info           │
│ - fields: Field[]           // Class fields                 │
│ - baseClass?: string        // Inherited class name         │
│ - sourceText: string        // Original source text         │
│ - imports: ClassImport[]    // Imports used by the class    │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   DomainEvent   │  │     Command     │  │      Query      │
├─────────────────┤  ├─────────────────┤  ├─────────────────┤
│ messageType:    │  │ messageType:    │  │ messageType:    │
│   'event'       │  │   'command'     │  │   'query'       │
│ version?: number│  │ resultType?:    │  │ resultType?:    │
│ context?: string│  │   TypeRef       │  │   TypeRef       │
│ payloadType?:   │  │ context?: string│  │ context?: string│
│   TypeRef       │  │ payloadType?:   │  │ payloadType?:   │
│                 │  │   TypeRef       │  │   TypeRef       │
└─────────────────┘  └─────────────────┘  └─────────────────┘

// Type guards
isDomainEvent(msg: Message): msg is DomainEvent  // messageType === 'event'
isCommand(msg: Message): msg is Command          // messageType === 'command'
isQuery(msg: Message): msg is Query              // messageType === 'query'
```

### 2. Field

```
┌─────────────────────────────────────────────────────────────┐
│                         Field                               │
├─────────────────────────────────────────────────────────────┤
│ - name: string              // Field name                   │
│ - type: TypeRef             // Type reference               │
│ - optional: boolean         // Optional flag                │
│ - readonly: boolean         // Readonly flag                │
└─────────────────────────────────────────────────────────────┘
```

### 3. TypeRef (Type Reference)

TypeRef is the core of the type system. All types are represented in a unified way.

```
                         TypeRef
                            │
    ┌───────────┬───────────┼───────────┬───────────┐
    │           │           │           │           │
    ▼           ▼           ▼           ▼           ▼
Primitive   Array       Object      Union      Reference
    │           │           │           │           │
string      T[]         {a:T}      A | B      UserType
number      Array<T>
boolean
null
undefined
void
any
unknown
never
bigint
symbol
                    │           │
                    ▼           ▼
              Intersection   Literal    Tuple    Function
                    │           │          │          │
                  A & B     'foo'|42   [A,B,C]  (a:T)=>R
```

#### 3.1 PrimitiveType

```typescript
interface PrimitiveType {
  kind: 'primitive';
  name: 'string' | 'number' | 'boolean' | 'null' | 'undefined'
      | 'void' | 'any' | 'unknown' | 'never' | 'bigint' | 'symbol';
}
```

#### 3.2 ArrayType

```typescript
interface ArrayType {
  kind: 'array';
  elementType: TypeRef;
}
```

#### 3.3 ObjectType

```typescript
interface ObjectType {
  kind: 'object';
  fields: readonly Field[];
}
```

#### 3.4 UnionType

```typescript
interface UnionType {
  kind: 'union';
  types: readonly TypeRef[];
}
```

#### 3.5 IntersectionType

```typescript
interface IntersectionType {
  kind: 'intersection';
  types: readonly TypeRef[];
}
```

#### 3.6 ReferenceType

```typescript
interface ReferenceType {
  kind: 'reference';
  name: string;                     // Type name
  typeArguments?: readonly TypeRef[]; // Generic arguments
}
```

#### 3.7 LiteralType

```typescript
interface LiteralType {
  kind: 'literal';
  value: string | number | boolean;
}
```

#### 3.8 TupleType

```typescript
interface TupleType {
  kind: 'tuple';
  elements: readonly TypeRef[];
}
```

#### 3.9 FunctionType

```typescript
interface FunctionType {
  kind: 'function';
  parameters: readonly FunctionParameter[];
  returnType: TypeRef;
}

interface FunctionParameter {
  name: string;
  type: TypeRef;
  optional: boolean;
}
```

### 4. TypeDefinition

Represents the complete structure of an externally defined type.

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeDefinition                           │
├─────────────────────────────────────────────────────────────┤
│ - name: string              // Type name                    │
│ - kind: 'interface' | 'type' | 'enum' | 'class'            │
│ - sourceFile: SourceFile    // Original file                │
│ - body: TypeRef             // Type body                    │
│ - typeParameters?: string[] // Generic parameters           │
│ - exported: boolean         // Export flag                  │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 EnumDefinition

```typescript
interface EnumMember {
  name: string;
  value?: string | number;
}

interface EnumDefinition extends Omit<TypeDefinition, 'kind' | 'body'> {
  kind: 'enum';
  members: readonly EnumMember[];
}
```

### 4.2 ClassDefinition

Information about classes referenced by Events/Commands. Unlike types, source text is preserved as-is.

```
┌─────────────────────────────────────────────────────────────┐
│                    ClassDefinition                          │
├─────────────────────────────────────────────────────────────┤
│ - name: string              // Class name                   │
│ - kind: 'class'             // Always 'class'               │
│ - sourceFile: SourceFile    // Original file                │
│ - sourceText: string        // Original source text (full)  │
│ - imports: ClassImport[]    // Imports referenced by class  │
│ - dependencies: string[]    // Referenced type/class names  │
│ - baseClass?: string        // Base class name              │
│ - exported: boolean         // Export flag                  │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 ClassImport

Import information used by a class.

```
┌─────────────────────────────────────────────────────────────┐
│                      ClassImport                            │
├─────────────────────────────────────────────────────────────┤
│ - names: string[]           // Imported names               │
│ - source: string            // Import path                  │
│ - isTypeOnly: boolean       // `import type` flag           │
│ - isExternal: boolean       // External package flag        │
└─────────────────────────────────────────────────────────────┘
```

**Class vs Type Differences:**
- Type: Analyze AST, convert to `TypeRef`, then generate code
- Class: Copy source text as-is (methods, decorators, JSDoc preserved)

**Import Generation Rules:**

| Target | isTypeOnly | Reason |
|--------|------------|--------|
| Type (`type`, `interface`) | `true` allowed | Only type needed |
| Class | `false` required | Class is a value, needed at runtime |
| External package | Preserve original | Respect external package import style |

**Note:** Importing a Class with `import type` will break `instanceof` at runtime

### 5. SourceFile

```
┌─────────────────────────────────────────────────────────────┐
│                      SourceFile                             │
├─────────────────────────────────────────────────────────────┤
│ - absolutePath: string      // Absolute path                │
│ - relativePath: string      // Relative path (from rootDir) │
│ - packageName?: string      // Package name (if any)        │
└─────────────────────────────────────────────────────────────┘
```

### 6. Dependency

Information about external types/values referenced by a Message.

```
┌─────────────────────────────────────────────────────────────┐
│                      Dependency                             │
├─────────────────────────────────────────────────────────────┤
│ - name: string              // Import name                  │
│ - source: ImportSource      // Import source                │
│ - kind: DependencyKind      // Dependency kind              │
│ - definition?: TypeDefinition // Resolved definition        │
└─────────────────────────────────────────────────────────────┘

ImportSource =
  | { type: 'local'; path: string }      // Local file
  | { type: 'external'; package: string } // External package

DependencyKind = 'type' | 'value' | 'class'
```

### 7. DecoratorNames

Customizes decorator names used to identify public messages.

```typescript
interface DecoratorNames {
  event?: string;   // Default: "PublicEvent"
  command?: string; // Default: "PublicCommand"
  query?: string;   // Default: "PublicQuery"
}

const DEFAULT_DECORATOR_NAMES: Required<DecoratorNames> = {
  event: "PublicEvent",
  command: "PublicCommand",
  query: "PublicQuery",
};
```

### 8. ResponseNamingConvention

Defines naming patterns for matching response types to messages.

```typescript
interface ResponseNamingConvention {
  messageSuffix: string;   // e.g., "Request"
  responseSuffix: string;  // e.g., "Response"
}

// Example: CreateUserRequest → CreateUserResponse
```

### 9. ExtractionResult

```
┌─────────────────────────────────────────────────────────────┐
│                   ExtractionResult                          │
├─────────────────────────────────────────────────────────────┤
│ - events: DomainEvent[]                                     │
│ - commands: Command[]                                       │
│ - types: TypeDefinition[]   // Extracted dependent types    │
│ - dependencies: Dependency[] // Dependency info             │
│ - errors: ExtractionError[]                                 │
│ - warnings: ExtractionWarning[]                             │
└─────────────────────────────────────────────────────────────┘
```

### 10. ProcessContextResult

Actual result type returned by `processContext()`.

```
┌─────────────────────────────────────────────────────────────┐
│                  ProcessContextResult                       │
├─────────────────────────────────────────────────────────────┤
│ - events: DomainEvent[]      // Extracted events            │
│ - commands: Command[]        // Extracted commands          │
│ - queries: Query[]           // Extracted queries           │
│ - copiedFiles: string[]      // Copied file paths           │
└─────────────────────────────────────────────────────────────┘
```

## Type Resolution Flow

```
1. Discover TypeRef in Message field
   e.g., userId: UserId

2. If ReferenceType, attempt to resolve
   - Find definition in same file
   - Track import to find definition
   - Mark as external if external package

3. Obtain TypeDefinition
   - interface UserId = string & Brand<'UserId'>

4. Recursively resolve TypeRefs in body
   - Brand<'UserId'> is external package

5. Cache results (prevent circular references)
```

## Filtering Rules

Items excluded during extraction:

### Backend-only Dependencies
- `node:*` (Node.js built-in modules)
- `pg`, `sqlite3` (databases)
- `typeorm`, `prisma` (ORMs)
- `express`, `fastify` (web frameworks)

### Non-extractable Patterns
- Interfaces in `implements` clause (not needed at runtime)
- Private fields (`#field`, `private field`)
- Methods (only data extracted)

## Example

### Input (Backend)

```typescript
// packages/lecture/src/events/lecture-created.ts
import { Message } from '@hexaijs/core';
import { UserId } from '../domain/user-id';

@PublicEvent()
export class LectureCreated extends Message {
  constructor(
    public readonly lectureId: string,
    public readonly title: string,
    public readonly createdBy: UserId,
  ) {
    super();
  }
}
```

```typescript
// packages/lecture/src/domain/user-id.ts
export type UserId = string & Brand<'UserId'>;
```

### Domain Model (Internal)

```typescript
const lectureCreatedEvent: DomainEvent = {
  name: 'LectureCreated',
  messageType: 'event',
  sourceFile: {
    absolutePath: '/project/packages/lecture/src/events/lecture-created.ts',
    relativePath: 'packages/lecture/src/events/lecture-created.ts',
    packageName: 'lecture',
  },
  fields: [
    { name: 'lectureId', type: { kind: 'primitive', name: 'string' }, readonly: true, optional: false },
    { name: 'title', type: { kind: 'primitive', name: 'string' }, readonly: true, optional: false },
    { name: 'createdBy', type: { kind: 'reference', name: 'UserId' }, readonly: true, optional: false },
  ],
  version: undefined,
  context: 'lecture', // inferred from package
};

const userIdType: TypeDefinition = {
  name: 'UserId',
  kind: 'type',
  sourceFile: { ... },
  body: {
    kind: 'intersection',
    types: [
      { kind: 'primitive', name: 'string' },
      { kind: 'reference', name: 'Brand', typeArguments: [{ kind: 'literal', value: 'UserId' }] },
    ],
  },
  exported: true,
};
```

### Output (contracts)

```typescript
// contracts/src/events/lecture-created.ts
import { Message } from '@hexaijs/core';
import type { UserId } from '../types/user-id';

export class LectureCreated extends Message {
  constructor(
    public readonly lectureId: string,
    public readonly title: string,
    public readonly createdBy: UserId,
  ) {
    super();
  }
}
```

```typescript
// contracts/src/types/user-id.ts
import type { Brand } from '@hexaijs/core';

export type UserId = string & Brand<'UserId'>;
```
