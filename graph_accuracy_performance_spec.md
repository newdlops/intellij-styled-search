# Fast Semantic Graph Index Spec

이 문서는 usage, caller, callee, implementation 그래프를 빠르고 견고하게 만들기 위한 기준이다.
목표는 상용 IDE 수준보다 정확한 semantic graph를 만들되, 대형 저장소에서도 count query가 예측 가능한 시간 안에 끝나도록 하는 것이다.

절대 원칙:

- `missing = 0`, `missed = 0`, `undercount = 0`을 먼저 만족한다.
- warmed index 기준 `100,000개 symbol count aggregation <= 10s`를 만족한다.
- exact를 올리는 작업은 undercount를 만들면 실패다.
- 프로젝트 이름, 도메인 모델 이름, benchmark corpus 문자열로 문제를 해결하지 않는다.
- 모든 rule은 언어 문법, 타입 시스템, import/export, 상속/override, framework contract, generated metadata에 근거해야 한다.
- MCP/extension client는 재연결 시 저장된 포트를 믿지 않고 현재 endpoint를 다시 탐색한다.

## Core Architecture

하나의 graph 알고리즘으로 모든 문제를 해결하지 않는다.
세 계층을 분리하고 마지막에 serving graph로 materialize한다.

```text
Blackbird/Zoekt style fast index
  + GitHub StackGraph style file-incremental syntactic graph
  + Google Kythe style compiler/build semantic fact graph
  => Materialized Must/May serving graph
```

각 계층의 책임:

- `FastIndex`: content, path, symbol, raw name candidate 검색. exact 근거로 사용하지 않는다.
- `FileGraph`: 파일 단위 definitions, references, scopes, imports, exports 추출. build 없이 생성 가능해야 한다.
- `SemanticFacts`: compiler, typechecker, build config, framework metadata, generated source mapping에서 온 semantic fact.
- `ServingGraph`: query를 위해 미리 계산한 edge shard와 count sidecar.

query path는 `ServingGraph`만 읽는다.
query 시점에 parser, typechecker, framework provider, regex scan을 실행하지 않는다.

## Mathematical Model

정확한 graph는 단일 그래프가 아니라 경계 그래프다.

```text
MustGraph <= RealProgramGraph <= MayGraph
```

- `MustGraph`: 반드시 존재한다고 증명된 edge.
- `MayGraph`: 존재할 수 있는 모든 edge를 포함하는 보수적 상한.
- `RealProgramGraph`: 실제 언어 semantics와 runtime에서 발생하는 edge. 완전히 관측할 수 없다.

count는 정수 하나가 아니라 interval이다.

```text
GraphCountInterval {
  lower_bound = must_count
  upper_bound = may_count
  exact = lower_bound == upper_bound
}
```

undercount 0의 의미:

```text
for every symbol s:
  real_count(s) <= may_count(s)
```

Exact의 의미:

```text
must_count(s) == may_count(s)
```

보장 경계:

- 어떤 static graph도 모든 runtime behavior를 100% 증명하지 못한다.
- 이 spec의 보장은 `RealProgramGraph` 자체의 완전 복원이 아니라 `MayGraph` 상한의 soundness와 `MustGraph` 증거의 재현성이다.
- exact는 "실제 프로그램 전체에 대한 신탁"이 아니라 "현재 compilation/framework/schema generation에서 `MUST == MAY`로 증명된 구간"이다.
- 지원하지 않는 언어/프레임워크 surface는 조용히 빠지지 않고 unsupported/may-only diagnostic으로 남아야 한다.

## Edge Bound Model

`MustGraph`와 `MayGraph`를 물리적으로 두 벌 저장하지 않는다.
하나의 edge row에 bound bit를 둔다.

```text
BoundMask:
  MAY      = 0b0001
  MUST     = 0b0010
  OBSERVED = 0b0100

exact static edge: MAY | MUST
possible edge:     MAY
observed edge:     OBSERVED
```

count sidecar는 이 bit를 누적한다.

```text
if edge.bound_mask has MUST:
  count.must += 1

if edge.bound_mask has MAY:
  count.may += 1
```

fallback edge는 `MAY`만 가질 수 있다.
compiler/typechecker/framework contract로 단일 target이 증명될 때만 `MUST`를 추가한다.
runtime observation은 기본적으로 `OBSERVED`이며, static `MAY`를 삭제하는 근거가 아니다.

## Physical Data Model

### FileGraph

파일 단위로 독립 생성한다.

```text
FileGraph {
  file_id
  content_hash
  language
  definitions[]
  references[]
  lexical_scopes[]
  import_export_edges[]
  local_name_binding_edges[]
  unresolved_ref_sites[]
}
```

역할:

- source occurrence universe를 만든다.
- build/typechecker가 실패해도 reference site를 버리지 않는다.
- file hash가 같으면 재사용한다.

### SemanticFacts

compiler/build/typechecker/framework 결과를 language-agnostic fact로 저장한다.

```text
SemanticFacts {
  compilation_units[]
  resolved_imports[]
  resolved_symbols[]
  type_facts[]
  member_facts[]
  hierarchy_facts[]
  override_facts[]
  implementation_facts[]
  generated_mappings[]
  framework_facts[]
}
```

provider examples. 이 목록은 exhaustive하지 않다:

- Python: pyright, django-stubs, static Django metadata extractor.
- TypeScript: TypeScript compiler API, tsconfig/project references/path aliases.
- Java: javac/JDT, Maven/Gradle source sets, classpath, annotation generated source.
- Rust/Go/C++/C#: compiler metadata, build graph, package/module config, generated source mapping.
- Framework: Django, Spring, React, GraphQL.
- Schema/Infra: OpenAPI, Protobuf, SQL migrations, IaC/build metadata.

## Semantic Fact Catalog

Semantic fact는 "나중에 resolver가 edge를 만들 수 있는 검증 가능한 중간 산출물"이다.
fact는 raw heuristic이 아니라 provider, input generation, confidence, invalidation key를 가진다.

공통 fact row:

```text
SemanticFact {
  fact_id
  fact_kind
  provider                  // parser | compiler | typechecker | framework | generated | runtime
  provider_version
  owner_file_id
  owner_symbol_id?
  scope_id?
  range?
  subject_id?               // symbol/ref/type/module/framework object
  object_id?                // target symbol/type/member/etc
  attributes
  bound_capability          // can_prove_must | may_only | observed_only
  evidence                  // AST node, compiler diagnostic, framework metadata, source map
  generation
  invalidation_keys[]
}
```

fact 설계 원칙:

- fact는 프로젝트 도메인 이름이 아니라 언어/프레임워크 구조에 근거한다.
- fact는 query 시점에 계산하지 않는다. build/update path에서 shard로 저장한다.
- fact는 edge가 아니다. resolver pass가 여러 fact를 조합해서 edge를 만든다.
- fact는 삭제 가능한 truth가 아니라 generation 단위 산출물이다. provider가 실패하면 기존 generation을 stale로 표시하고 MayGraph를 보존한다.
- runtime fact는 `OBSERVED` 근거이며 static `MAY`를 제거하는 근거가 아니다.

### Core Source Facts

모든 언어에 공통으로 필요한 source-level fact다.

```text
SourceFileFact {
  file_id
  rel_path
  language
  file_role                 // source | test | generated | declaration | config | dependency
  content_hash
  generated_origin?
  package_root?
}

SymbolDeclFact {
  symbol_id
  name
  qualified_name
  kind                      // module | package | class | function | method | field | enum | type | variable
  language
  declaration_range
  body_range
  container_symbol_id?
  signature_fingerprint
  visibility
}

RefSiteFact {
  source_ref_id
  raw_text
  normalized_name
  ref_kind                  // name | member | call | construct | import | export | annotation | string-key
  access_shape              // bare | member | chained-member | index | call-result | template | generated
  range
  enclosing_symbol_id?
  lexical_scope_id
}

LexicalScopeFact {
  scope_id
  parent_scope_id?
  owner_symbol_id?
  range
  scope_kind                // module | class | function | block | comprehension | lambda | template
}

BindingFact {
  scope_id
  name
  symbol_id
  binding_kind              // declaration | parameter | import | assignment | destructuring | pattern
  visibility_range
}
```

Resolver implications:

- `RefSiteFact + Unique BindingFact in visible scope`는 `MUST` 후보가 될 수 있다.
- definition token은 usage materialized edge에서 제외하되, conservative `usage_may` upper에는 포함될 수 있다.
- comment/string/template 내부 occurrence는 별도 `ref_kind`로 보존하고 일반 code ref와 섞지 않는다.

### Module, Import, Export Facts

이름 해석의 첫 번째 exact 근거다.

```text
ModuleFact {
  module_id
  file_id
  module_name
  package_root
  module_kind               // source | declaration | generated | namespace | package
}

ImportFact {
  file_id
  local_name
  imported_name
  module_specifier
  import_kind               // default | named | namespace | side_effect | wildcard | static
  resolved_module_ids[]
  is_type_only
}

ExportFact {
  file_id
  exported_name
  local_symbol_id?
  reexport_module_id?
  export_kind               // named | default | namespace | wildcard
}

PathAliasFact {
  config_file_id
  alias_pattern
  target_patterns[]
  applies_to_roots[]
}
```

언어별 source:

- Python: `import`, `from ... import ...`, package `__init__.py`, namespace package, `py.typed`, stub `.pyi`.
- TypeScript/JavaScript: `import`, `export`, `export *`, `require`, `paths`, `baseUrl`, project references, package `exports`.
- Java/Kotlin: package declaration, normal/static import, source set, classpath, generated source set.

Resolver implications:

- resolved module과 exported symbol이 단일이면 import edge는 `MUST`.
- wildcard import/export는 candidate set이 finite일 때 `MAY`, provider가 exact exported set을 주면 개별 `MUST` 가능.
- side-effect import는 symbol usage가 아니라 module initialization edge다.

### Type Facts

exact usage를 올리는 핵심 fact다.
타입 fact는 "이 expression/reference가 어떤 type set을 가질 수 있는가"를 표현한다.

```text
TypeFact {
  subject_ref_id | symbol_id
  type_expr
  type_set[]                 // finite symbols or type variables
  type_kind                  // exact | union | generic | protocol | unknown | any | never
  nullability
  generic_args[]
  variance?
  flow_scope_id?
  evidence_kind              // annotation | inference | checker | constructor | cast | guard | framework
}

SelfTypeFact {
  type_parameter_symbol_id
  declaring_scope_id
  bound_type_id
}

TypeAliasFact {
  alias_symbol_id
  target_type_expr
  target_type_set[]
}

OverloadFact {
  callable_symbol_id
  overload_signature_id
  parameter_types[]
  return_type
  applicability_condition
}

ReturnTypeFact {
  callable_symbol_id
  return_type_set[]
  evidence_kind              // annotation | checker | inferred | framework
}
```

type fact source:

- explicit annotation: `x: T`, `def f(x: T) -> R`, TS/Java parameter and return types.
- typechecker inference: Pyright, TypeScript checker, javac/JDT.
- constructor call: `x = T(...)`, `new T()`.
- cast/narrowing: `typing.cast`, TS `as`, Java cast, `isinstance`, `typeof`, `instanceof`.
- generic substitution: `QuerySet[Model]`, `List<T>`, `Promise<T>`, `Repository<Entity>`.
- framework provider: Django model field type, Spring bean generic, GraphQL generated type.

Resolver implications:

- `MemberRef(receiver.name) + TypeFact(receiver, exact T) + UniqueMember(T, name)` => `MUST`.
- `TypeFact(receiver, finite {T1,T2}) + members` => each candidate `MAY`, single candidate across set can be `MUST`.
- `Any/unknown/dynamic/__getattr__` never creates `MUST`; it may only widen `MAY`.
- Python `Self` must be keyed by declaring scope. The token string `Self` is never a global type identity.
- Type aliases and generic parameters must be expanded with declaring context, not by display name.

### Member and Shape Facts

member 해석은 class body뿐 아니라 descriptor, generated field, structural type까지 필요하다.

```text
MemberFact {
  owner_type_id
  member_symbol_id
  member_name
  member_kind                // method | property | field | enum_value | constructor | descriptor | synthetic
  staticness                 // instance | class | static | module
  visibility
  read_type_set[]
  write_type_set[]
}

StructuralMemberFact {
  shape_id
  member_name
  member_type_set[]
  required
  source                    // Protocol | interface | TypedDict | object literal | dataclass | generated
}

DescriptorFact {
  descriptor_symbol_id
  owner_type_id
  member_name
  get_return_type_set[]
  set_value_type_set[]
}

CallableFact {
  subject_type_id
  call_symbol_id?           // __call__, function signature, constructor, lambda
  parameter_types[]
  return_type_set[]
}
```

source examples:

- Python: class methods, `@property`, descriptors, dataclass fields, attrs fields, Pydantic fields, enum members, Protocol members, `TypedDict` keys.
- Django: model fields, reverse relations, managers, queryset methods, related descriptors.
- TypeScript: class/interface/type literal members, enum members, namespace merge, declaration merge, JSX component props.
- Java/Spring: fields, methods, record components, Lombok/generated members, bean methods, repository generated methods.

Resolver implications:

- nominal type member lookup follows language MRO/inheritance/interface rules.
- structural member lookup can create `MAY`; it becomes `MUST` only when checker/provider proves a unique structural target.
- descriptor/property read target and setter target are different edges.
- class member and instance member namespaces must not be merged unless language semantics allow it.

### Call, Constructor, and Callee Facts

caller/callee graph는 usage graph보다 더 많은 semantic fact를 요구한다.

```text
CallSiteFact {
  source_ref_id
  callee_expr_shape          // name | member | call-result | index-result | lambda | decorator
  argument_shapes[]
  enclosing_symbol_id
}

CalleeFact {
  callsite_ref_id
  target_callable_symbol_id
  receiver_type_set[]
  overload_signature_id?
  bound_mask_capability
}

ConstructFact {
  callsite_ref_id
  constructed_type_id
  constructor_symbol_id?
  factory_return_type_set[]
}

DecoratorFact {
  decorated_symbol_id
  decorator_symbol_id
  wrapper_symbol_id?
  preserves_signature
  return_type_set[]
}
```

Resolver implications:

- function name call with unique lexical/import binding can be `MUST`.
- method call requires receiver type and overload/member resolution.
- constructor call may target class constructor and class symbol separately.
- decorator/HOC/proxy wrapper must preserve both "decorated symbol usage" and "actual callable target".
- factory return inference without explicit annotation/checker evidence is `MAY` only. Name-based factory heuristics are forbidden.

### Hierarchy, Override, and Implementation Facts

implementation graph는 type hierarchy fact 위에서 계산한다.

```text
HierarchyFact {
  child_type_id
  parent_type_id
  relation_kind              // extends | implements | mixin | protocol | trait | typeclass
  mro_order?
}

OverrideFact {
  child_member_id
  parent_member_id
  compatibility              // exact | compatible | incompatible | unknown
  dispatch_kind              // virtual | abstract | default | final | sealed
}

ImplementationFact {
  interface_symbol_id
  implementation_symbol_id
  implementation_kind        // class | method | bean | resolver | generated
}

AbstractContractFact {
  contract_symbol_id
  required_members[]
  sealed_subtypes[]?
}
```

language/framework source:

- Python: base classes, MRO, ABC, Protocol, Django model inheritance, mixins.
- TypeScript: `extends`, `implements`, structural assignability, declaration merge.
- Java: class/interface hierarchy, abstract/default methods, sealed classes, records, annotation processors.
- Spring: bean implementation of interface, repository generated implementation.

Resolver implications:

- nominal override with compatible signature can be `MUST`.
- structural implementation is `MAY` unless compiler/checker provides exact assignability evidence.
- sealed/final hierarchy can close candidate sets and turn some `MAY` into `MUST`.

### Flow and Alias Facts

flow-sensitive facts improve exact without widening globally.

```text
AliasFact {
  alias_symbol_id | ref_id
  target_symbol_id | target_ref_id
  alias_kind                 // assignment | import | destructuring | reexport | parameter_forwarding
  scope_id
}

FlowNarrowFact {
  subject_symbol_id | ref_id
  narrowed_type_set[]
  guard_range
  active_range
  guard_kind                 // isinstance | typeof | instanceof | null-check | pattern-match | assertion
}

ValueKeyFact {
  container_ref_id
  key_literal
  value_type_set[]
  source                    // TypedDict | object literal | dict literal | JSON schema | GraphQL variables
}
```

Resolver implications:

- alias fact transfers symbol identity only inside visibility range.
- flow narrowing is range-limited; it must not rewrite global type facts.
- string-key facts can feed framework/template/GraphQL edges but must be separate from normal identifier usage.

### Python and Django Facts

Python은 dynamic fallback을 보수적으로 유지하면서 type/provider fact로 exact를 올린다.

```text
PythonImportResolutionFact
PythonStubMergeFact          // .py + .pyi, py.typed
PythonMroFact
PythonDataclassFieldFact
PythonDescriptorFact
PythonPropertyFact
PythonProtocolMemberFact
PythonTypedDictKeyFact
PythonDecoratorFact
PythonSelfTypeFact

DjangoAppFact
DjangoModelFact
DjangoModelFieldFact
DjangoForeignKeyFact
DjangoReverseRelationFact
DjangoManagerFact
DjangoQuerySetFact
DjangoQuerySetMethodFact
DjangoLookupFact
DjangoUrlPatternFact
DjangoViewFact
DjangoTemplateFact
DjangoSignalFact
DjangoFormSerializerFieldFact
```

Django resolver rules:

- `Model.field`는 model class body, inherited abstract model, generated descriptor를 모두 반영한다.
- `ForeignKey(to=Target, related_name=R)`는 `Target.R` reverse relation member fact를 만든다.
- `related_query_name`은 queryset lookup namespace fact이며 normal member와 분리한다.
- `Manager[Model]`, `QuerySet[Model]`, custom manager/queryset method는 generic `Model` binding을 보존한다.
- `objects`, custom manager, `as_manager()`는 model-specific manager fact로 저장한다.
- `filter(foo__bar=...)`, `values("field")`, `order_by("field")` 같은 string lookup은 `DjangoLookupFact`로 저장하고 normal code usage와 분리한다.
- `select_related/prefetch_related` path는 relation path fact로 저장한다.
- URLConf route to view, class-based view method, template name, signal receiver는 framework edge로 저장한다.

금지:

- `QuerySet`, `Manager`, `Factory` 같은 이름 suffix만 보고 return/member type을 추론하지 않는다.
- 프로젝트 모델 이름, app 이름, field 이름으로 special case를 만들지 않는다.
- `Self` token을 전역 타입처럼 취급하지 않는다.

### TypeScript, JavaScript, and React Facts

```text
TsProgramFact
TsResolvedModuleFact
TsSymbolFact
TsTypeFact
TsSignatureFact
TsOverloadFact
TsJsxComponentFact
TsJsxPropFact
TsNamespaceMergeFact
TsDeclarationMergeFact
TsReExportFact
ReactComponentFact
ReactHookFact
ReactContextFact
ReactHocFact
```

TS/React resolver rules:

- TypeScript checker symbol id가 있으면 AST same-name보다 우선한다.
- `export *`와 barrel re-export는 export graph로 풀어서 저장한다.
- type-only import는 runtime call edge가 아니지만 type/member resolution에는 사용한다.
- interface/type literal member는 structural member fact다.
- JSX `<Component prop=...>`는 `Component` usage와 prop member usage를 분리한다.
- `memo`, `forwardRef`, HOC는 wrapper component와 wrapped component edge를 모두 저장한다.
- hook dependency나 context provider/consumer는 React framework edge이며 normal call edge와 provenance를 분리한다.

### Java and Spring Facts

```text
JavaCompilationUnitFact
JavaClasspathFact
JavaTypeFact
JavaMethodSignatureFact
JavaOverrideFact
JavaAnnotationFact
JavaGeneratedSourceFact
SpringBeanFact
SpringInjectionPointFact
SpringRouteFact
SpringRepositoryFact
SpringEventListenerFact
SpringAopFact
```

Java/Spring resolver rules:

- javac/JDT resolved binding은 `MUST` 근거다.
- overload는 erased signature와 generic substitution을 모두 저장한다.
- Lombok/annotation processor output은 generated source mapping과 함께 member fact를 만든다.
- Spring bean name/type/qualifier/profile/conditional fact는 DI edge candidate set을 제한한다.
- `@RequestMapping` route, repository method, event listener, scheduled method, AOP advice는 framework edge로 저장한다.
- reflection string class name은 normal usage가 아니라 reflection fact다.

### GraphQL, Template, and Config Facts

```text
GraphqlSchemaTypeFact
GraphqlFieldFact
GraphqlOperationFact
GraphqlFragmentFact
GraphqlResolverFact
GraphqlCodegenMappingFact
TemplateSymbolFact
TemplateIncludeFact
ConfigKeyFact
ConfigBindingFact
```

Resolver rules:

- GraphQL operation field usage targets schema field, not same-named code symbol.
- resolver mapping connects schema field to code callable with framework provenance.
- generated GraphQL TS/Python types keep source operation/schema origin.
- template variable/member references use template context type facts.
- config keys and environment keys are separate namespace facts.

### Wider Language Coverage Facts

Python/Django, TS/React, Java/Spring은 우선순위가 높지만 모델의 범위는 여기에 갇히지 않는다.
새 언어는 아래 fact family 중 필요한 subset을 제공하면 같은 resolver/count pipeline에 올라탄다.

```text
RustCrateFact
RustModuleFact
RustUseFact
RustTraitFact
RustImplFact
RustMacroExpansionFact
RustCargoFeatureFact

GoModuleFact
GoPackageFact
GoInterfaceFact
GoMethodSetFact
GoBuildTagFact
GoGeneratedFact

CppTranslationUnitFact
CppIncludeFact
CppNamespaceFact
CppTemplateFact
CppMacroExpansionFact
CppOverloadSetFact
CppVirtualOverrideFact

CSharpProjectFact
CSharpNamespaceFact
CSharpPartialTypeFact
CSharpExtensionMethodFact
CSharpAttributeFact
CSharpGeneratedSourceFact

KotlinModuleFact
KotlinExtensionFunctionFact
KotlinDataClassFact
KotlinCoroutineFact

SwiftModuleFact
SwiftProtocolFact
SwiftExtensionFact
SwiftPropertyWrapperFact

RubyConstantFact
RubyMixinFact
RubyRailsRouteFact
RubyActiveRecordModelFact
RubyMetaprogrammingFact

PhpNamespaceFact
PhpComposerAutoloadFact
PhpTraitFact
PhpAttributeFact
PhpLaravelRouteFact
```

coverage rules:

- Rust: trait impl, inherent impl, `use`/re-export, macro expansion, cargo feature cfg를 분리한다. macro generated symbol은 generated mapping 없이는 `MUST`가 될 수 없다.
- Go: package-level identity, interface satisfaction, method set, embedded field promotion, build tags를 fact로 저장한다.
- C/C++: include graph, macro expansion, namespace, overload set, template instantiation, compile command database를 semantic provider의 기본 invalidation key로 둔다.
- C#: partial class, extension method, attribute/generated source, project reference, nullable flow fact를 저장한다.
- Kotlin/Swift: extension function/property와 protocol/interface conformance를 normal member와 분리한다.
- Ruby/PHP: metaprogramming, autoload, framework route/model fact는 `MAY`를 넓히는 source이며, static proof 없이 `MUST`가 되지 않는다.

### API, Schema, Data, and Infra Facts

code graph는 source file만 보지 않는다.
real usage는 API schema, DB schema, message schema, generated client/server, build config, deployment config에서 들어온다.
이들은 normal identifier namespace와 분리된 semantic namespace로 저장한다.

```text
SqlSchemaFact
SqlTableFact
SqlColumnFact
SqlQueryFact
OrmMappingFact
MigrationFact

OpenApiSpecFact
OpenApiOperationFact
OpenApiSchemaFact
OpenApiGeneratedClientFact

ProtobufMessageFact
ProtobufFieldFact
GrpcServiceFact
GrpcMethodFact

JsonSchemaFact
AvroSchemaFact
ThriftSchemaFact

MessageTopicFact
QueueConsumerFact
QueueProducerFact
EventPayloadFact

CliCommandFact
ShellInvocationFact
TaskRunnerFact

IaCResourceFact
IaCReferenceFact
ContainerImageFact
DeploymentRouteFact

BuildTargetFact
BuildDependencyFact
GeneratedArtifactFact
```

resolver rules:

- SQL table/column usage targets SQL schema symbols, not same-named code variables.
- ORM mapping connects model field/member to table/column with framework provenance.
- migration files create schema evolution facts; current schema is a materialized view over migration facts.
- OpenAPI/Protobuf/GraphQL schema generated code must retain source schema origin.
- gRPC service method usage connects generated client call, server implementation, schema method, and network route as separate edges.
- message topic/queue producer-consumer links are framework/runtime contract edges, not direct call edges.
- shell/CLI invocation of Python/Node/Java code is an execution edge only when command target can be resolved from entry point metadata.
- IaC references such as service name, container image, route, function handler are config namespace facts.
- build target dependency is not code usage unless it maps to a symbol or generated artifact origin.

### Cross-Language Bridge Facts

multi-language repo에서는 한 언어의 symbol이 다른 언어의 generated/client/runtime surface로 노출된다.

```text
ForeignFunctionFact
NativeBindingFact
GeneratedClientFact
GeneratedServerStubFact
TemplateContextBridgeFact
RouteHandlerBridgeFact
SchemaCodegenBridgeFact
ReflectionBridgeFact
```

bridge rules:

- bridge edge는 source namespace와 target namespace를 명시한다.
- generated client/server stub은 origin schema와 generated symbol 양쪽 id를 가진다.
- FFI/native binding은 build config, header/module map, binding generator output이 evidence다.
- reflection bridge는 exact class/function symbol이 resolved될 때만 `MUST`; string pattern만 있으면 `MAY`.
- template/context bridge는 framework provider가 context type을 줄 때만 member exact를 올릴 수 있다.

### Detailed Coverage Scope Matrix

coverage scope는 "어떤 파일을 읽는다"가 아니라 "어떤 semantic surface를 graph로 표현한다"로 정의한다.
각 surface는 namespace, fact kind, resolver rule, validation path를 가진다.

```text
CoverageSurface {
  surface_id
  namespace                 // code | type | module | schema | db | config | runtime | build | infra
  source_artifacts[]
  produced_facts[]
  edge_kinds[]
  minimum_tier
  exact_provider?
  conservative_fallback
  independent_validation
}
```

#### Universal Code Scope

모든 언어 provider가 최소한 커버해야 하는 공통 code scope다.

| surface | required facts | edges | exact provider | conservative fallback |
|---|---|---|---|---|
| file/module/package | `SourceFileFact`, `ModuleFact` | module usage, import, export | compiler/module resolver | same module namespace MAY |
| declarations | `SymbolDeclFact` | definition identity | parser/compiler AST | parser partial tree |
| lexical references | `RefSiteFact`, `LexicalScopeFact`, `BindingFact` | usage, call | scope resolver | visible same-name MAY |
| imports/exports/includes | `ImportFact`, `ExportFact`, `PathAliasFact` | usage, module init, re-export | module resolver | resolved file candidate MAY |
| member access | `TypeFact`, `MemberFact` | usage, call, construct | typechecker/member lookup | receiver-name scoped MAY |
| hierarchy | `HierarchyFact`, `OverrideFact` | implements, overrides | compiler/typechecker | declared base-name MAY |
| generated code | `GeneratedMappingFact` | synthetic usage, generated symbol | source map/generator metadata | generated namespace MAY |

Universal exclusions:

- binary/image/archive/media files are never parsed as code.
- dependency/vendor/generated files are indexed only as declaration/source surfaces allowed by config.
- comments and strings do not become normal code usage. They become doc/string/config/schema facts only when a provider owns that namespace.

#### Language Family Scope

언어별 provider는 아래 surface를 가능한 한 fact로 분리한다.

| family | source artifacts | must cover | exact evidence | may-only surface |
|---|---|---|---|---|
| Python | `.py`, `.pyi`, `pyproject`, type checker config | modules, imports, classes, functions, methods, properties, descriptors, dataclasses, enums, Protocol, TypedDict, decorators, overloads, type aliases | Pyright/stubs/AST + MRO | `Any`, dynamic attrs, monkey patch, `getattr`, import side effects |
| JS/TS | `.ts`, `.tsx`, `.js`, `.jsx`, `tsconfig`, package metadata | ESM/CJS, exports, declarations, class/interface/type members, overloads, JSX, decorators, namespace/declaration merge | TypeScript checker | dynamic property access, untyped JS, eval, broad index signatures |
| JVM | Java/Kotlin/Scala source, Gradle/Maven/Bazel metadata | packages, classes, interfaces, methods, fields, generics, overloads, annotations, generated members, sealed/final hierarchy | javac/JDT/Kotlin compiler | reflection strings, dynamic proxies, conditional beans |
| Rust | crates, modules, `Cargo.toml`, feature cfg, macro output | items, modules, traits, impls, associated items, generics, re-exports, macro-generated symbols | rustc/rust-analyzer | unresolved macro expansion, cfg-disabled items |
| Go | modules, packages, build tags, generated files | packages, funcs, methods, interfaces, method sets, embedded fields, generic instantiations | gopls/go/packages | reflection, build-tag excluded files |
| C/C++ | compile commands, headers, source, defines | translation units, includes, namespaces, classes, templates, overloads, virtual dispatch, macros | clangd/libclang | macro-only unresolved names, missing compile command |
| .NET | C#/F# projects, Razor, generated source | namespaces, partial types, extension methods, attributes, nullable flow, LINQ, source generators | Roslyn | reflection strings, dynamic |
| Mobile | Swift/ObjC/Kotlin/XML/storyboard/resources | modules, protocols, extensions, resources, generated binding, UI/action wiring | compiler/build metadata | runtime selectors without binding metadata |
| Dynamic web | Ruby/PHP/Elixir/etc. | constants/modules, mixins/traits, framework routes, ORM models, templates | language server/framework metadata | metaprogramming, autoload not resolved |

#### Scope Completeness Matrix

이 matrix의 셀은 비워둘 수 없다.
provider가 아직 구현되지 않은 surface도 `source universe`, `MAY fallback`, `unsupported diagnostic` 중 하나로 표현해야 한다.
빈 셀은 silent undercount 위험이므로 실패로 본다.

| ecosystem | source universe | declarations | binding/import | type/member | call/callee | hierarchy/implementation | framework/generated/schema | dynamic boundary | validation oracle |
|---|---|---|---|---|---|---|---|---|---|
| Universal source | git/workspace files with binary/media/vendor/generated policy | stable symbol ids for parsed declarations | lexical scope and module-local names | member ref site recorded even when type unknown | call syntax and construct syntax recorded | declared parent/implements names recorded | generated origin marker and config namespace | same-scope/name `MAY`, never `MUST` | `rg` source occurrence plus parser fixture |
| Python | `.py`, `.pyi`, package roots, type config | module/class/function/method/property/field/type alias | importlib-compatible import, relative import, alias, re-export | annotation, MRO, descriptor, dataclass/attrs/Pydantic/TypedDict/Protocol | function, method, constructor, decorator, context/iterator/async protocol | class inheritance, Protocol implementation, override by MRO/signature | Django/FastAPI/Celery/stub/generated facts | `Any`, monkey patch, `getattr`, module `__getattr__` are `MAY` | Pyright/LSP plus `rg` independent census |
| Django | settings/apps/models/migrations/urls/templates/admin/forms/serializers | app/model/field/manager/queryset/view/template symbols | app registry, URL include, template loader | model meta, field descriptor, reverse relation, queryset generic | ORM/queryset methods, CBV `as_view`, signal receiver, management command | model inheritance, proxy/abstract/multi-table, manager/queryset binding | migrations, model fields, relations, serializers/forms/admin/templates | string lookup, missing settings, conditional app config are broad `MAY` | django-stubs/Django metadata plus `rg` |
| JavaScript/TypeScript | TS/JS/JSX/TSX declarations, package metadata, project refs | value/type/namespace declarations, overloads, merged declarations | ESM/CJS/package exports/path alias/type-only imports | TS checker type, structural members, JSX props, JSDoc | function/method/constructor/tagged template/decorator calls | class/interface extends/implements, declaration merge | React/Next/Vue/Svelte route/component/codegen facts | `any`, dynamic property, eval, untyped JS are `MAY` | TypeScript checker plus text census |
| React/frontend | component files, router manifests, CSS/assets/i18n | component/hook/route/style/resource symbols | import graph, route file convention with manifest | props/context/ref/state/resource key types | JSX component invocation, hook call, loader/action call | HOC/wrapper component origin, framework component boundary | router/compiler manifest, CSS module, generated server/client boundary | spread props without type, runtime route params are `MAY` | framework manifest plus checker/source search |
| JVM | Java/Kotlin/Scala/Groovy source, classpath, build metadata | package/class/interface/enum/record/annotation/member symbols | package/import/static import/source-set/classpath | compiler binding, generics, nullability, property accessor | overload, constructor, lambda target, method reference | extends/implements/sealed/default/bridge methods | annotation processors, resources, service loader | reflection, dynamic proxy, missing classpath are `MAY` | javac/JDT/Kotlin compiler plus `rg` |
| Spring/JVM frameworks | component scan roots, config files, resources | bean/controller/repository/config/property symbols | ApplicationContext, qualifier/profile/property binding | bean type, proxy target, repository entity type | injection, web handler, listener, scheduler, repository method | interface proxy, AOP advice target, repository implementation | generated proxies, config properties, derived query/schema | conditional/profile-dependent beans are `MAY` | Spring metadata/test context plus source search |
| Rust | crate roots/modules/Cargo/features/build output | crate/module/item/trait/impl/associated item/macro symbols | module tree, `use`, glob, re-export, visibility, prelude | rustc types, trait selection, deref/autoref, associated type | function/method/UFCS/operator/closure/async calls | trait impl, inherent impl, blanket/negative impl, supertrait | macro expansion, build script generated files, cfg facts | unexpanded macro or inactive cfg is `MAY`/excluded by unit | rust-analyzer/rustc plus source occurrence |
| Go | packages/modules/build tags/generated/cgo | package/const/var/type/func/method/interface/field | import path, module replace, internal visibility | go/types, method set, embedded field, generic constraint | func/method/interface call, defer/go, type assertion/switch | interface satisfaction, promoted methods, receiver method set | generated files, cgo binding, init order facts | reflection and inactive build tags are `MAY` | go/packages/gopls plus `rg` |
| C/C++ | translation units, headers, compile commands, generated headers | namespace/type/function/method/template/macro symbols | include graph, include paths, macros, linkage | clang AST types, typedef/auto/decltype/template instantiation | overload/ADL/operator/ctor/dtor/function pointer/lambda | inheritance, virtual dispatch, override/final, concepts | generated headers, CMake/Bazel targets, codegen mapping | missing compile command, unresolved macro, points-to set are `MAY` | clangd/libclang plus text census |
| .NET | C#/F#/VB/Razor/project/generated files | assembly/namespace/type/member/property/event/delegate symbols | project refs, global using, partial type merge | Roslyn type, nullable flow, extension methods, dynamic marker | overload/LINQ/delegate/lambda/async calls | inheritance/interface/explicit implementation/partial methods | source generators, Razor/XAML generated mapping | `dynamic`, reflection, missing generator output are `MAY` | Roslyn plus source search |
| Ruby/Rails | Ruby files, Gemfile, routes, schema, views | constants/classes/modules/methods/attributes | require/autoload, constant resolution, Rails loader | RBI/RBS/Steep/Sorbet types, ActiveRecord schema | method/send, route action, callback, scope | mixin/prepend/include, inheritance, concern | Rails routes/models/views/jobs/mailers/schema | `method_missing`, dynamic constantize, metaprogramming are `MAY` | LSP/Sorbet/Rails metadata plus `rg` |
| PHP/Laravel | PHP files, Composer autoload, routes, config, Blade | namespace/class/trait/interface/method/property symbols | Composer PSR autoload, use aliases, container binding | PHPStan/Psalm types, attributes, model properties | function/method/static/container/route/controller calls | inheritance/interfaces/traits, Laravel contract binding | routes, Eloquent models, migrations, Blade, config | magic methods, container string, dynamic include are `MAY` | PHPStan/Psalm/framework metadata plus source search |
| Elixir/Phoenix | `.ex/.exs`, mix, router, templates/live views | module/function/macro/behaviour/protocol symbols | alias/import/require/use, application deps | typespecs, behaviours, macro expansion output | function call, capture, GenServer callback, route/live view | behaviour callbacks, protocol impls, `use` injected callbacks | Phoenix routes/channels/live views/Ecto schema | unexpanded macro/dynamic atom dispatch are `MAY` | compiler xref plus source search |
| SQL/schema | migrations, DDL, ORM metadata, query files | table/column/index/constraint/view/procedure symbols | schema search path, migration generation | column type, relation, constraint, generated column | query/table/column/procedure reference | foreign key/view/procedure dependency | ORM bridge, migration lineage, generated clients | raw SQL string without parser context is `MAY` | SQL parser/DB schema dump plus text search |
| API/IDL | OpenAPI/GraphQL/Protobuf/Thrift/Avro/AsyncAPI | service/operation/type/message/field symbols | schema import/include/ref resolution | schema type, input/output, nullability/repeated | client/server method, resolver, subscription/event | interface/service implementation, generated stub override | codegen source maps, route/client/server bridge | string endpoint/topic without schema is `MAY` | schema compiler/codegen plus source search |
| Templates/docs | Jinja/Django/Razor/ERB/Thymeleaf/Markdown | template/block/slot/filter/tag/doc-anchor symbols | include/extend/component import/link target | context variable type, prop/slot type, filter signature | render/include/component/filter calls | template inheritance/block override | framework template loader, generated view code | untyped context var and sample code are separate namespace `MAY` | template compiler plus text search |
| Build/config/infra | Bazel/Gradle/Maven/Cargo/npm/Go/CMake/Docker/Kubernetes/Terraform/CI | target/task/service/resource/config-key symbols | dependency graph, workspace/package/module mapping | config schema/resource type/env profile | entry point/task/handler invocation | target dependency, deployment ownership | generated artifacts, deployment route, service binding | shell strings/env-dependent config are `MAY` | build tool metadata plus file search |
| Runtime observations | traces, logs, coverage, profiler, request samples | observed runtime symbol ids when resolved | runtime module/class/function identity | runtime receiver/type sample | observed call/route/event edge | observed dispatch/implementation edge | observed DI/proxy/generated runtime target | `OBSERVED` only; cannot delete static `MAY` | trace replay and source location mapping |

#### Exact Promotion Matrix

`MUST` 승격은 아래 조건을 모두 만족할 때만 허용한다.
조건 하나라도 빠지면 `MAY` 또는 `OBSERVED`로 남긴다.

| surface | required proof for `MUST` | demote to `MAY` when | never counts as normal usage |
|---|---|---|---|
| lexical variable/function | unique binding in exact lexical scope | shadowing/scope recovery is incomplete | comments and arbitrary strings |
| import/export/module | resolver returns single exported symbol for active compilation unit | wildcard export/import set is incomplete | package name text in docs |
| member access | exact receiver type or finite exact type set plus unique member lookup | receiver is unknown/dynamic/structural without checker proof | same-named key in plain data |
| call/callee | resolved callable symbol and language call semantics agree | overload set is unresolved or target set is open | function name in config without entry point mapping |
| constructor/factory | language constructor or framework-generated constructor metadata resolves target | factory return type is not provided by checker/framework metadata | name suffix/prefix convention alone |
| override/implementation | compiler/typechecker compatible signature and hierarchy id | hierarchy is name-only or dependency is missing | same method name across unrelated classes |
| framework contract | provider exposes deterministic contract with config generation | profile/settings/environment is unknown | framework-looking string without provider ownership |
| generated code | generated symbol and source origin mapping are stable | generated file has no origin map | generated comment/header text |
| schema bridge | schema compiler/parser resolves symbol and generated/client mapping | raw string cannot be parsed in schema context | same-named code identifier without bridge |
| runtime observation | static proof also exists for exact static count | only trace/log evidence exists | observed-only edge in static `MUST` |

#### Edge Kind Coverage Matrix

각 edge kind는 어떤 surface에서 생성될 수 있는지와 어떤 namespace에 속하는지 고정한다.
문자열이 같은 것만으로 namespace를 넘는 edge를 만들 수 없다.

| edge kind | source surfaces | target surfaces | `MUST` evidence | `MAY` fallback | count bucket |
|---|---|---|---|---|---|
| `usage` | lexical ref, import ref, member ref, schema ref, template ref | symbol, member, module, schema field, generated symbol | binding/import/type/schema/template provider single target | visible same-name or namespace-scoped candidate set | usage_must/usage_may |
| `call` | call expression, decorator, annotation-generated invocation, framework dispatch | callable symbol, method, constructor, handler, generated stub | language call resolver or deterministic framework dispatch | callable-name candidate with scope/type/provider boundary | calls_out/calls_in |
| `construct` | constructor syntax, class instantiation, factory metadata | class/constructor/generated constructor | compiler/typechecker constructor binding | class-name candidate in module/type namespace | usage plus construct count |
| `implements` | class/interface/trait/protocol declaration, framework contract | interface/trait/protocol/abstract member | compiler/typechecker hierarchy relation | declared base-name with unresolved dependency | impl_must/impl_may |
| `overrides` | method/member declaration in hierarchy | overridden method/member | compatible signature in resolved hierarchy | same member name inside unresolved declared hierarchy | override_must/override_may |
| `route` | route table, annotation, file route, deployment route | handler/controller/action/server function | framework/router manifest single handler | path/controller convention with provider-owned namespace | framework route count |
| `injection` | constructor/field/setter/provider parameter | bean/provider/service implementation | DI container metadata with qualifier/profile generation | type/name candidate inside DI context | framework usage |
| `schema_bridge` | ORM field, SQL query, API schema, IDL generated code | table/column/operation/message/field | schema parser/codegen/generated map | parsed string in schema namespace without unique target | schema usage |
| `template_bridge` | template variable/tag/filter/component slot | context symbol/filter/component/slot | template compiler/framework context type | untyped context name inside template namespace | template usage |
| `build_exec` | task script, entry point metadata, CLI config | executable module/function/main class/binary | build/package entry point resolver | shell command with resolvable file/module candidate | execution edge |
| `runtime_observed` | trace/log/coverage/profiler/request sample | observed runtime target | runtime symbol id mapped to static symbol and static proof exists | runtime-only mapped target | observed only unless static proof exists |

caller/callee query rules:

- `caller`는 `call`, `construct`, framework dispatch edge의 incoming projection이다.
- `callee`는 같은 edge들의 outgoing projection이다.
- `usage`와 `call`은 분리한다. 호출은 usage를 포함할 수 있지만 usage detail에서 provenance를 유지한다.
- `implementation`은 `implements`, `overrides`, framework contract implementation을 포함하되 schema/config bridge와 혼합하지 않는다.
- edge kind별 namespace가 다르면 UI에서 함께 보여줄 수는 있어도 count sidecar는 별도 bucket을 유지한다.

#### Unsupported Surface Policy

지원하지 않는 surface를 조용히 버리는 것은 undercount다.
구현 전 단계에서도 아래 중 하나를 반드시 기록한다.

- `UnsupportedSurfaceFact`: artifact와 언어/framework 후보를 manifest에 기록한다.
- `MayOnlySurfaceFact`: exact provider는 없지만 source occurrence universe에는 포함한다.
- `ExternalProviderRequiredDiagnostic`: 어떤 compiler/framework/schema provider가 있어야 exact가 가능한지 기록한다.
- `ExcludedSurfaceFact`: binary/media/archive/vendor처럼 정책상 제외된 artifact와 제외 이유를 기록한다.

unsupported surface는 조용히 성공으로 처리하지 않는다.
scope 밖이면 `coverage_gap/unsupported`로 보고하고, scope 안으로 선언된 surface라면 `missing`으로 집계해서 gate를 실패시킨다.
exact 개선 작업보다 먼저 source universe와 scope admission이 확정되어야 한다.

#### Per-Ecosystem Coverage Requirements

이 절은 provider가 누락하면 안 되는 semantic surface를 더 세밀하게 고정한다.
아래 항목이 모두 `MUST` edge를 만든다는 뜻은 아니다.
각 항목은 최소한 fact로 보존되어야 하며, 증거 수준에 따라 `MUST`, `MAY`, `OBSERVED`로 materialize된다.

##### Python Coverage

source artifacts:

- `.py`, `.pyi`, `py.typed`, `pyproject.toml`, `setup.cfg`, `mypy.ini`, `pyrightconfig.json`.
- package `__init__.py`, namespace packages, editable installs, generated stubs.

required facts:

- module/package identity, relative/absolute imports, star imports with exported set, import alias, re-export through `__init__.py`.
- lexical scopes: module, class, function, lambda, comprehension, generator, pattern matching, exception handler.
- declarations: class, function, async function, method, property, variable, constant, type alias, `TypeVar`, `ParamSpec`, `TypeVarTuple`.
- class model: MRO, metaclass, `__mro_entries__`, `__init_subclass__`, `__class_getitem__`, `__slots__`.
- attributes: class body fields, instance fields from `self.x`, descriptors, `@property`, setters/deleters, `cached_property`.
- generated members: dataclass, attrs, Pydantic model, enum members, namedtuple, TypedDict keys.
- typing: annotations, overloads, Protocol structural members, `Self` scoped by declaring class, `NewType`, `Literal`, `Annotated`, generic substitution.
- calls: function call, method call, constructor call, `__call__`, decorator application, context manager `__enter__/__exit__`, iterator `__iter__/__next__`, async iterator.
- dynamic surfaces: `getattr`, `setattr`, `hasattr`, `globals`, `locals`, monkey patch, module `__getattr__`, plugin import.

exact policy:

- Pyright/stub resolved symbol can produce `MUST`.
- MRO/member lookup with exact receiver type and unique member can produce `MUST`.
- dynamic attribute and monkey patch facts are `MAY` unless runtime/static provider resolves the target.

##### Django Coverage

source artifacts:

- settings module, installed apps, model modules, migrations, URLConf, templates, management commands, forms, serializers, admin, signals.

required facts:

- app registry: app label, model label, swappable model, abstract/proxy/multi-table inheritance.
- model members: concrete field, deferred field, property, descriptor, generated `id`, custom primary key, meta options.
- relationships: `ForeignKey`, `OneToOneField`, `ManyToManyField`, through model, `related_name`, `related_query_name`, reverse descriptor.
- managers/querysets: default manager, base manager, custom manager, `as_manager`, `from_queryset`, queryset subclass methods, model-bound generic type.
- ORM lookup namespace: `filter`, `exclude`, `get`, `annotate`, `alias`, `aggregate`, `values`, `values_list`, `order_by`, `select_related`, `prefetch_related`, `only`, `defer`, `F`, `Q`.
- migration schema: create/alter/rename/remove field/model, index/constraint, data migration function target.
- URL/view: path/re_path/include, class-based view `as_view`, view methods, middleware, decorators.
- template: template file, context variable, include/extend/block, template tag/filter, form field.
- signals/admin/forms/serializers: receiver target, model binding, generated fields, validation hooks.

exact policy:

- app registry/model meta facts can create deterministic framework `MUST`.
- string ORM lookup creates schema/framework edges, not normal identifier usage.
- missing settings or migration state downgrades exact but must preserve broad model/field `MAY`.

##### JavaScript and TypeScript Coverage

source artifacts:

- `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.d.ts`, `.d.mts`, `.d.cts`.
- `tsconfig.json`, `jsconfig.json`, project references, package `exports/imports`, `type`, path aliases, lockfiles.

required facts:

- module format: ESM, CommonJS, dual package, `node16/node18/node20/nodenext`, dynamic import, `import = require`, `export =`.
- imports/exports: default, named, namespace, re-export, `export *`, type-only, import types, ambient modules, module augmentation.
- declarations: value/type/namespace spaces, class, interface, type alias, enum, const enum, namespace, variable, function, overload.
- declaration merging: interface merging, namespace-class/function/enum merge, global augmentation, module augmentation.
- type system: structural type, generic, conditional/mapped/indexed/template literal types, `keyof`, `typeof`, `infer`, type guards, `satisfies`.
- members: class fields/methods/accessors, private fields, static blocks, interface/type literal members, index signatures.
- JS-specific: JSDoc types, prototype assignment, `module.exports`, `exports.x`, object literal API, optional chaining.
- calls: overload resolution, construct signatures, call signatures, tagged templates, decorator application.
- JSX/TSX: intrinsic elements, component symbol, props type, children, ref, key, fragments, namespace factory.

exact policy:

- TypeScript checker symbol/type id is `MUST` evidence.
- untyped JS, broad index signatures, `any`, dynamic property names, `eval`, plugin-loaded modules are `MAY`.
- type-only import is usable for type/member resolution but not runtime call edge.

##### React and Frontend Framework Coverage

required facts:

- component identity: function/class component, memo/forwardRef/lazy, HOC wrapper, display name.
- props: JSX attributes, spread props, default props, children, ref, context value.
- hooks: custom hook call, dependency array references, state setter, reducer dispatch.
- routing: React Router/Next/Nuxt/SvelteKit route file, loader/action/server component boundary.
- assets/styles: CSS module class, styled component, imported asset, i18n key.
- framework-specific generated files: Next app router, Remix routes, Vue/Svelte compiled component metadata.

exact policy:

- framework compiler/router manifest can produce `MUST` route/component edges.
- JSX spread props without checker object type remain `MAY`.

##### JVM Coverage

source artifacts:

- Java, Kotlin, Scala, Groovy source, generated source, `pom.xml`, Gradle files, Bazel targets, annotation processor config.

required facts:

- package/module/source-set identity, classpath, test/main separation, generated source origin.
- declarations: class, interface, enum, record/data class, sealed class/interface, annotation, object/singleton, companion object.
- members: field, method, constructor, property accessor, record component, enum constant, nested type.
- type system: generics, wildcards, bounds, type erasure, nullability annotations, Kotlin platform types.
- calls: overload resolution, constructor, method reference, lambda target functional interface, default/interface method.
- hierarchy: extends/implements, sealed permitted subclasses, abstract/final/default/static method, bridge methods.
- annotations/processors: Lombok, MapStruct, Dagger, AutoValue, JPA, Spring, Micronaut generated/synthetic members.
- resources: properties/yaml/xml config, service loader `META-INF/services`, persistence config.

exact policy:

- javac/JDT/Kotlin compiler binding is `MUST`.
- annotation-generated member is `MUST` only with generated source or processor metadata.
- reflection strings and dynamic proxies are `MAY` unless framework/runtime resolves them.

##### Spring and JVM Framework Coverage

required facts:

- bean definitions: component scan, `@Bean`, XML bean, factory bean, scope, profile, conditional, primary, qualifier, name alias.
- injection points: constructor, field, setter, method parameter, collection/map injection, lazy/provider injection.
- AOP/proxy: advice, pointcut, proxy target class/interface, transactional/cache/security annotations.
- web: `@RequestMapping`, composed mappings, path variable, request param/body/header, controller advice, exception handler.
- data: Spring Data repository, derived query method, custom implementation, entity mapping, transaction boundary.
- messaging/events: listener annotation, topic/queue destination, event publisher/listener, scheduled method.
- config: configuration properties binding, SpEL, property placeholder, profile-specific config.

exact policy:

- resolved ApplicationContext/bean graph can produce DI `MUST`.
- conditional/profile-dependent bean edge is `MAY` unless active environment is fixed.
- proxy/AOP edges use framework provenance and do not replace direct call graph.

##### Rust Coverage

source artifacts:

- crate roots, modules, `Cargo.toml`, `Cargo.lock`, workspace manifest, feature cfg, `build.rs`, proc macro output.

required facts:

- crate/module tree, `mod` source file mapping, `#[path]`, visibility, prelude, extern crate.
- `use` tree, glob import, re-export, renamed import, macro import/export.
- declarations: function, struct, enum, union, trait, type alias, const/static, module, macro.
- impls: inherent impl, trait impl, blanket impl, negative impl, unsafe impl, specialization if enabled.
- trait members: associated function/type/const, default method, supertrait, dyn compatibility.
- type system: generics, lifetimes, where clauses, associated types, opaque `impl Trait`, trait object, auto traits.
- calls: method resolution, UFCS, deref/autoref, operator trait, closure, async desugaring.
- macros: `macro_rules!`, proc macro derive/attribute/function-like, expansion mapping, generated items.
- cfg/features: `cfg`, `cfg_attr`, cargo features, target-specific items.

exact policy:

- rustc/rust-analyzer resolved def id is `MUST`.
- unexpanded macro tokens, cfg-disabled items, missing feature/target are `MAY` or excluded by compilation unit.

##### Go Coverage

source artifacts:

- packages/modules, `go.mod`, `go.sum`, vendor, build tags, generated `.go`, cgo.

required facts:

- package identity, import path, module replacement, internal package visibility.
- declarations: const, var, type, function, method, interface, struct field, embedded field.
- method sets: value/pointer receiver, promoted methods from embedding, interface satisfaction.
- type system: aliases, defined types, generics, constraints/type sets, comparable, underlying type.
- calls: function, method, interface dispatch, composite literal, type assertion/switch, goroutine/defer edge.
- initialization: package init order, `init` functions, variable initializer dependency.
- generated/cgo: generated source marker, cgo binding, build constraints.

exact policy:

- go/packages/gopls type info is `MUST`.
- reflection, string method names, build-tag inactive files are not `MUST`.

##### C and C++ Coverage

source artifacts:

- source/header files, `compile_commands.json`, `compile_flags.txt`, CMake/Bazel/Ninja metadata, generated headers.

required facts:

- translation unit, include graph, header ownership, include search path, target triple, language standard, defines.
- preprocessor: macro definition/use/expansion, conditional compilation, generated tokens.
- declarations: namespace, class/struct/union, enum, typedef/using, variable, function, method, template.
- type system: templates, specialization, concepts, SFINAE, typedef aliases, cv/ref qualifiers, auto/decltype.
- calls: overload set, ADL, virtual dispatch, constructor/destructor, operator overload, function pointer, lambda.
- hierarchy: inheritance, virtual base, override/final, pure virtual, access control.
- linkage: static/extern, anonymous namespace, symbol visibility.

exact policy:

- clang AST/binding with correct compile command is `MUST`.
- missing/borrowed compile command, unresolved macro expansion, function pointer target set without points-to analysis are `MAY`.

##### .NET Coverage

source artifacts:

- C#, F#, VB, Razor, project files, solution files, generated source, analyzer/source generator output.

required facts:

- assembly/project/namespace identity, partial types/methods, global using, top-level statements.
- declarations: class, struct, record, interface, enum, delegate, event, property, field, method, constructor.
- type system: generics, constraints, nullable flow, dynamic, tuples, pattern matching.
- members: extension methods, explicit interface implementation, indexer, operator, async state machine.
- calls: overload resolution, LINQ query syntax, delegate/lambda, reflection, attribute-driven binding.
- generated: source generators, Razor generated code, XAML bindings.

exact policy:

- Roslyn symbol id is `MUST`.
- `dynamic`, reflection, source generator missing output are `MAY`.

##### Mobile and UI Resource Coverage

required facts:

- Android XML resource ids, layouts, navigation graph, manifest components, generated `R` symbols, Compose functions.
- iOS storyboard/xib, SwiftUI view, Objective-C selector, IBOutlet/IBAction, asset catalogs.
- resource key to code symbol mapping, generated binding origin, localization keys.

exact policy:

- generated binding/resource manifest can produce `MUST`.
- runtime selector string without binding metadata is `MAY`.

##### Dynamic Language and Web Framework Coverage

required facts:

- Ruby constants/modules/classes, mixins, Rails routes/controllers/models/views, ActiveRecord associations/scopes.
- PHP namespaces/classes/traits, Composer autoload, Laravel routes/controllers/models/blades, attributes.
- Elixir modules/functions/macros, Phoenix routes/controllers/live views, behaviours.
- metaprogramming hooks, autoload, convention-based framework mapping as explicit framework facts.

exact policy:

- language server/framework metadata can produce `MUST`.
- convention-only inference and metaprogramming without expansion is `MAY`.

#### Framework Scope

framework facts are not special strings. They are contracts exposed by a framework provider.

| framework class | examples | required facts | graph edges |
|---|---|---|---|
| web routing | Django/FastAPI/Flask, Spring MVC, Express/Nest, Rails, ASP.NET | route, method, path params, handler symbol, middleware chain | route -> handler, handler caller, middleware call |
| ORM/data model | Django ORM, SQLAlchemy, Prisma, Hibernate/JPA, EF, ActiveRecord, Sequelize | model, field, relation, table, column, generated query API | model-field, relation, query method, schema bridge |
| dependency injection | Spring, Angular, Nest, Guice/Dagger, ASP.NET DI | provider, injection point, qualifier, scope, conditional activation | injection usage, implementation candidate |
| task/event | Celery, Sidekiq, Spring events, Node queues, Kafka consumers | task name/topic, producer, consumer, payload type | producer-consumer, event-handler |
| template/render | Django/Jinja, JSX, Vue/Svelte, Razor, ERB, Thymeleaf | template file, context symbol, include/extend, component/slot/prop | template usage, context member |
| serialization/API | DRF, Pydantic, Jackson, serde, protobuf, OpenAPI | schema field, serializer field, generated type, endpoint operation | schema-code bridge |
| test/mocking | pytest, unittest, Jest, JUnit, RSpec | test target, fixture, parameterized case, mock patch target | test usage, patch usage |

framework provider requirements:

- framework namespace is separated from normal code namespace.
- generated/synthetic members store origin provider and framework contract.
- provider failure cannot remove FileGraph May candidates.
- exact promotion requires deterministic framework metadata, not naming convention.

#### Schema, Data, and Storage Scope

data/schema surfaces must be first-class graph nodes.

| surface | artifacts | facts | edges |
|---|---|---|---|
| relational schema | SQL DDL, migrations, ORM metadata | table, column, index, constraint, migration operation | model-column, query-column, migration-schema |
| query text | SQL strings, query builders, prepared statements | parsed query, table refs, column refs, parameter refs | query -> schema symbol |
| API schema | OpenAPI/Swagger, GraphQL SDL, AsyncAPI | operation, path, method, input/output schema | endpoint -> handler/client |
| IDL/RPC | Protobuf, Thrift, Avro, gRPC | service, method, message, field | generated client/server/schema |
| document schema | JSON Schema, XML Schema | type, field, validation keyword | config/data object -> schema |
| cache/search | Redis keys, Elasticsearch/OpenSearch mappings | key pattern, index, field mapping | producer/consumer/schema |

rules:

- schema symbols are counted separately from code symbols unless a bridge fact connects them.
- string literals that match schema names are `MAY` until parsed by a schema-aware provider.
- migrations are append-only input facts; current schema is derived with generation.

#### Build, Config, and Deployment Scope

build/config/infra files affect graph identity and cross-language edges.

| surface | artifacts | facts | impact |
|---|---|---|---|
| build graph | Bazel, Gradle, Maven, Cargo, npm/pnpm/yarn, Go modules, CMake | build target, source set, dependency, generated artifact | provider invalidation, module visibility |
| package metadata | `package.json`, `pyproject`, `Cargo.toml`, `go.mod`, composer, gemspec | package id, exports, entry points, dependencies | import/module resolution |
| config | YAML/TOML/JSON/properties/env | config key, binding target, profile/environment | framework activation, DI/route/schema |
| deployment | Kubernetes, Docker, Terraform, Helm, Serverless | service, route, image, function handler, env ref | runtime/config bridge |
| task runners | Make, npm scripts, Gradle tasks, shell scripts, CI | command, entry point, working directory, env | execution edge when resolvable |

rules:

- config value usage is not normal identifier usage.
- shell/CLI invocation becomes code execution edge only when entry point is resolved structurally.
- build graph controls which files belong to compilation units; missing build graph downgrades exact only.

#### Runtime and Observation Scope

runtime observation is optional and never replaces static upper bounds.

| surface | observed fact | edge |
|---|---|---|
| function call tracing | `RuntimeObservedEdgeFact` | `OBSERVED` call |
| import/module load | module load event | observed module init |
| route handling | request -> handler | observed route edge |
| message handling | topic -> consumer | observed producer-consumer edge |
| reflection/dynamic dispatch | resolved runtime target | observed usage/call |

rules:

- observed edge may raise UI confidence.
- observed edge cannot delete static `MAY`.
- observed edge can guide prioritization of exact provider work.
- runtime data must be keyed by environment and runtime context hash.

#### Documentation and Comment Scope

documentation is searchable and can contain references, but it is a different namespace.

```text
DocReferenceFact
MarkdownLinkFact
CodeFenceFact
DocSymbolMentionFact
```

rules:

- doc mentions do not count as normal usage by default.
- code fences may be parsed as sample code only under doc/sample namespace.
- markdown links to files/symbol anchors can create doc-reference edges.

#### Minimum Scope for New Provider

새 provider는 아래 checklist 없이는 exact-producing provider가 될 수 없다.

- [ ] source artifact discovery and exclusion policy.
- [ ] symbol declarations with stable ids.
- [ ] reference sites with stable source ref ids.
- [ ] scope/binding or module/import resolution.
- [ ] conservative May upper that survives provider failure.
- [ ] exact evidence kind list.
- [ ] invalidation keys and provider version.
- [ ] generated/dependency handling.
- [ ] neutral fixtures for each rule.
- [ ] independent validation path that does not use the same graph output as oracle.

### Coverage Tiers

새 ecosystem을 추가할 때는 한 번에 full semantic exact를 목표로 하지 않는다.
coverage tier를 명시해서 undercount 0과 성능을 먼저 지킨다.

```text
Tier 0: Source Universe
  - file discovery, binary/generated/dependency filtering
  - symbol declarations
  - ref sites
  - conservative same-namespace MAY upper

Tier 1: Lexical and Module Resolution
  - scopes and bindings
  - imports/exports/includes/module resolution
  - unique lexical/import MUST

Tier 2: Type and Member Resolution
  - checker/compiler type facts
  - member lookup
  - overload/constructor/call resolution
  - exact receiver/member MUST where provable

Tier 3: Framework and Generated Metadata
  - framework contracts
  - generated source mapping
  - schema/API/config bridge facts

Tier 4: Flow, Runtime, and Cross-Language
  - flow narrowing
  - observed runtime edges
  - FFI/schema/client/server bridges
```

acceptance per tier:

- lower tier output must remain valid when higher tier provider times out.
- Tier 0/1 must maintain `missing=0`, `missed=0`, `undercount=0`.
- Tier 2+ may improve `usageCount`/`MUST`, but must not shrink `usageMay`.
- every tier has neutral fixtures and at least one real-world census report.

### Provider Contract and Invalidation

넓은 coverage를 유지하려면 provider마다 invalidation key를 엄격히 저장해야 한다.

```text
ProviderContract {
  provider_id
  provider_version
  input_files[]
  config_files[]
  environment_fingerprint
  dependency_fingerprint
  output_fact_shards[]
  timeout_policy
}
```

invalidation examples:

- Python: `pyproject.toml`, `mypy.ini`, `pyrightconfig.json`, `settings.py`, installed stubs.
- TypeScript: `tsconfig.json`, `package.json`, lockfile, project references.
- Java/Kotlin: `pom.xml`, Gradle files, source set, classpath, annotation processor config.
- Rust: `Cargo.toml`, `Cargo.lock`, features, target cfg.
- Go: `go.mod`, `go.sum`, build tags.
- C/C++: compile commands, include paths, defines, target triple.
- API/schema: schema files, codegen config, generator version.
- Framework: settings/config files, route registry, migration state, generated metadata.

provider failure policy:

- provider timeout degrades exact only.
- stale exact facts are not reused as `MUST` unless generation matches.
- stale May upper from FileGraph remains valid if source universe generation matches.
- provider stderr/diagnostic is stored in manifest for regression analysis.

### Generated and Runtime Facts

```text
GeneratedMappingFact {
  generated_file_id
  origin_file_id
  origin_range
  generated_range
  generator_id
  generator_version
}

RuntimeObservedEdgeFact {
  observed_ref
  target_symbol_id
  edge_kind
  sample_count
  runtime_context_hash
}
```

Rules:

- generated code may create `MUST` only when origin mapping and generated symbol identity are stable.
- generated code without origin mapping is indexed as generated/declaration, not source truth.
- runtime observed edge adds `OBSERVED`; it cannot reduce `MAY`.
- runtime fact can promote UI confidence but not static exact unless the static proof also exists.

### Fact to Bound Policy

`MUST`로 올릴 수 있는 evidence:

- compiler/typechecker resolved symbol binding.
- unique lexical binding in exact scope.
- unique resolved import/export binding.
- exact receiver type plus unique member under language member lookup.
- exact hierarchy/override with compatible signature.
- framework metadata that defines a deterministic contract, such as Django model field or Spring bean method generated by annotation processor.

`MAY`만 가능한 evidence:

- same-name lexical fallback.
- unknown/Any/dynamic receiver.
- wildcard import without exact exported set.
- structural type without checker assignability.
- reflection/string lookup.
- dynamic `getattr`, `setattr`, `__getattr__`, proxy object, monkey patch.
- runtime observation without static proof.

삭제/축소가 가능한 candidate:

- only inside the same bound interval proof. 예: `TypeFact`가 finite exact set을 제공하면 broad same-name candidates를 `usageCount`에서는 제외할 수 있다.
- `usageMay`는 독립 검증 proxy보다 작아지면 안 된다.
- fallback candidate 삭제는 provider failure, timeout, missing config 상황에서 금지한다.

### ServingGraph

query 전용 materialized graph다.

```text
ServingGraph {
  symbol_table
  edge_by_target
  edge_by_source
  call_adjacency
  implementation_table
  count_sidecar
  generation_manifest
}
```

edge row:

```text
EdgeRow {
  source_ref_id
  source_symbol_id
  target_symbol_id
  edge_kind              // usage | call | construct | implements | overrides | synthetic
  bound_mask             // MAY | MUST | OBSERVED
  confidence             // exact | probable | possible | unresolved | synthetic
  provenance_bits        // lexical | import | typechecker | hierarchy | framework | fallback
  evidence_bits
  source_range
  enclosing_symbol_id
  owner_generation
}
```

count row:

```text
GraphCount {
  symbol_id
  usage_must
  usage_may
  calls_in_must
  calls_in_may
  calls_out_must
  calls_out_may
  impl_must
  impl_may
  updated_generation
}
```

## Symbol Identity

display name은 identity가 아니다.
Kythe VName과 비슷한 stable id를 사용한다.

```text
GlobalSymbolId {
  corpus
  revision
  root
  path
  language
  kind
  signature
  generated_origin_id
}
```

규칙:

- 같은 이름이어도 path, language, kind, signature가 다르면 다른 symbol이다.
- `Self`, generic parameter, overload, declaration merge는 declaring context를 포함한다.
- generated symbol은 generated output과 source origin을 모두 가진다.
- unresolved symbol은 temporary id를 갖고, semantic fact가 생기면 remap한다.

## Build Pipeline

```text
1. Discover files
   - gitignore/config/generated/binary filters
   - source language detection
   - content hash

2. Build FastIndex
   - content/path/symbol postings
   - blob-level dedup

3. Build FileGraph
   - parser-based definitions/references/scopes/imports/exports
   - file-owned fact shard

4. Extract SemanticFacts
   - compiler/typechecker/build config
   - framework metadata
   - generated source mapping

5. Resolve Facts
   - lexical/import/type/member/call/hierarchy/framework/fallback passes
   - EdgeKey dedup
   - bound_mask assignment

6. Materialize ServingGraph
   - edge_by_target
   - edge_by_source
   - call_adjacency
   - implementation_table
   - count_sidecar

7. Validate
   - independent rg/search sample
   - compiler/LSP comparison
   - full census report
```

## Resolver Rules

Rules are compiled passes, not query-time Datalog.

```text
RefSite(name, scope) + UniqueLexicalBinding(scope, name, symbol)
  => Edge(bound=MAY|MUST, provenance=lexical)

RefSite(name, file) + ResolvedImport(file, name, symbol)
  => Edge(bound=MAY|MUST, provenance=import)

MemberRef(receiver, name) + TypeFact(receiver, Exact(type)) + UniqueMember(type, name, member)
  => Edge(bound=MAY|MUST, provenance=typechecker)

MemberRef(receiver, name) + TypeFact(receiver, FiniteSet(types)) + Members(types, name, members)
  => Edge(bound=MAY, provenance=typechecker)

Override(child_method, parent_method) + SignatureCompatible(child_method, parent_method)
  => Edge(bound=MAY|MUST, edge_kind=overrides, provenance=hierarchy)

RefSite(name, scope) + VisibleSymbols(scope, name, candidates) + NoMustEdge(ref)
  => Edge(bound=MAY, provenance=fallback)
```

Fallback 제한:

- workspace 전체 same-name fan-out은 금지한다.
- scope, import visibility, receiver evidence, file/module boundary로 candidate set을 제한한다.
- candidate set이 지나치게 넓으면 unresolved diagnostic으로 보존한다.
- fallback은 exact bucket에 들어갈 수 없다.

## Query Complexity

```text
single_count(symbol_id):
  count_sidecar lookup                  // O(1) or O(log N)

batch_count(symbol_ids):
  group by count shard + sequential read // O(M + shard_count)

detail_edges(symbol_id):
  edge_by_target lookup + range read     // O(log N + k)

callers/callees(symbol_id):
  call_adjacency lookup + range read     // O(log N + k)
```

`O(log N)` 안에 추론을 넣는 것은 목표가 아니다.
추론은 build/update path에서 하고, query는 materialized result를 읽는다.
100,000개 batch는 출력 크기 때문에 `O(M)`이 하한이다.

## Performance Targets

Warmed local index 기준:

- 100,000개 symbol count aggregation: `<= 10s`.
- 1,000개 symbol count batch: `<= 500ms p95`.
- 단일 usage/caller/callee/implementation count: `<= 50ms p95`.
- detail query with snippets: `<= 200ms p95`, snippet IO 제외 가능.
- changed file 1개 incremental update: `<= 1s`.
- changed file 100개 incremental update: `<= 5s`.

금지되는 count query 작업:

- source parse
- LSP/typechecker request
- raw reference 전체 scan
- regex fallback scan
- framework provider execution

## Robustness

- binary/image/media/archive 파일은 graph analysis 대상에서 제외한다.
- generated/vendor/dependency 파일은 config와 generated marker로 제외한다.
- 제외 결과도 manifest에 기록해 stale loop를 막는다.
- manifest commit은 atomic rename으로 끝낸다.
- schema version, resolver version, provider version이 바뀌면 관련 shard만 invalidate한다.
- partially written shard는 startup에서 폐기한다.
- stale 판정은 mtime 단독이 아니라 content hash 또는 generation과 함께 한다.
- LSP/typechecker timeout은 exact만 degrade시키고 FileGraph/MayGraph 생성을 막지 않는다.

## Validation

MCP graph로 MCP graph를 검증하지 않는다.
정확도 검증은 독립 경로를 사용한다.

- `rg` 기반 lexical ground truth.
- compiler/LSP output.
- neutral fixture project.
- real-world corpus full census.

report 필수 항목:

```text
total
present
missing
missed
under
exact
over
exact_rate
over_rate
by_language
by_kind
by_bound
by_provenance
top_false_positive_patterns
top_false_negative_patterns
timeout_candidates
```

Acceptance gate:

- `missing = 0`
- `missed = 0`
- `under = 0`
- exact 개선 PR은 위 세 조건을 유지해야 한다.
- overcount 감소 PR은 위 세 조건 중 하나라도 깨면 revert한다.
- 새 rule은 project-specific 문자열 없이 neutral fixture로 검증한다.

## Implementation Phases

### Phase 0. Layer Boundaries

- FastIndex, FileGraph, SemanticFacts, ServingGraph module을 분리한다.
- query path가 FileGraph/SemanticFacts를 직접 읽지 못하게 한다.
- exact 개선은 SemanticFacts와 resolver pass에서만 수행한다.

### Phase 1. Serving Edge Schema

- edge에 `source_ref_id`, `bound_mask`, `confidence`, `provenance_bits`, `evidence_bits`, `owner_generation`을 추가한다.
- count sidecar에 must/may counters를 저장한다.
- MCP/TS protocol에 bound/confidence/provenance를 노출한다.

### Phase 2. FileGraph Replacement

- 기존 same-name heuristic graph를 제거한다.
- parser 기반 definition/reference/scope/import/export fact shard를 만든다.
- build 실패와 상관없이 FileGraph는 생성되어야 한다.

### Phase 3. Semantic Provider Integration

- Python/Django, TypeScript, Java/Spring provider를 SemanticFacts로 연결한다.
- framework provider는 domain name이 아니라 framework contract만 사용한다.
- generated source mapping을 source origin과 함께 저장한다.

### Phase 4. Incremental and Count Performance

- impact index로 fact delta가 영향을 주는 edge만 재계산한다.
- edge delta로 count sidecar를 증감 갱신한다.
- 100,000개 count benchmark를 회귀 테스트로 고정한다.

### Phase 5. Exact Rate Improvement

- overcount를 provenance별로 측정한다.
- `MAY` 삭제가 아니라 abstract value narrowing으로 후보를 줄인다.
- `MUST` 승격에는 재현 가능한 evidence가 있어야 한다.

## Final Implementation Checklist Matrix

이 matrix의 모든 row는 구현 완료 전까지 추적 대상이다.
체크는 "코드가 있다"가 아니라 "독립 검증 gate를 통과했다"를 의미한다.

| done | area | implementation artifact | required behavior | acceptance gate | failure condition |
|---|---|---|---|---|---|
| [ ] | workspace discovery | file discovery manifest, exclusion manifest | source/config/schema/generated/dependency/binary/media surface를 분리한다 | binary/media/archive는 graph parse 대상 0개, 제외 사유 manifest 존재 | 제외 사유 없이 stale loop 또는 binary/image parse 시도 |
| [ ] | stable identity | `GlobalSymbolId`, source ref id, generation id | name이 아니라 path/language/kind/signature/origin으로 symbol/ref를 식별한다 | rename/shadow/overload/generic fixture에서 id collision 0 | `Self`, overload, generated symbol, declaration merge가 같은 id로 합쳐짐 |
| [ ] | FileGraph | per-file definition/reference/scope/import/export shard | build/typechecker 실패와 무관하게 source occurrence universe를 만든다 | provider timeout 상태에서도 `missing=0`, `missed=0`, `under=0` | semantic provider 실패가 source ref 누락으로 이어짐 |
| [ ] | SemanticFacts schema | language-agnostic fact rows with provider/generation/evidence | compiler/typechecker/framework/build/schema 결과를 edge가 아닌 fact로 저장한다 | stale provider generation은 `MUST`로 재사용되지 않음 | query path에서 provider를 직접 호출하거나 stale exact를 사용 |
| [ ] | bound edge schema | `EdgeRow.bound_mask`, provenance/evidence bits | `MAY`, `MUST`, `OBSERVED`를 한 edge row에서 표현한다 | exact edge는 `MAY + MUST`, fallback은 `MAY` only | fallback/runtime observation이 static `MUST`가 됨 |
| [ ] | count sidecar | `GraphCount` shard and delta update | usage/caller/callee/implementation count는 materialized sidecar만 읽는다 | 100,000 symbol count aggregation `<= 10s` warmed | count query에서 parse/LSP/regex/framework provider 실행 |
| [ ] | resolver pass boundary | lexical/import/type/member/call/hierarchy/framework/fallback passes | resolver는 fact를 조합해 edge를 만들고 query 시점 추론을 하지 않는다 | pass별 provenance 분포가 report에 기록됨 | same-name fan-out이 resolver provenance 없이 edge 생성 |
| [ ] | fallback policy | namespace/scope/import/receiver-bounded `MAY` candidates | fallback은 undercount 방지용 상한이며 exact bucket에 들어가지 않는다 | fallback-only edge의 `MUST` count 0 | workspace-wide same-name fan-out 또는 fallback exact 승격 |
| [ ] | exact promotion policy | `Exact Promotion Matrix` implementation checks | `MUST` 승격은 compiler/typechecker/framework/schema의 재현 가능한 증거가 있을 때만 수행한다 | promoted edge마다 evidence bit와 provider generation 존재 | raw name, suffix/prefix, project corpus 문자열로 exact 승격 |
| [ ] | unsupported surface policy | `UnsupportedSurfaceFact`, `MayOnlySurfaceFact`, `ExcludedSurfaceFact` | 지원하지 않는 surface를 조용히 버리지 않고 scope/gap으로 보고한다 | declared scope 내부 unsupported는 `missing` gate 실패 | unsupported language/framework file이 성공처럼 숨겨짐 |
| [ ] | generated source mapping | generated-origin map and generated symbol ids | generated symbol은 output id와 source origin id를 모두 가진다 | generated fixture에서 source-origin bridge 재현 | generated file을 원본 source truth로만 취급 |
| [ ] | build/config integration | build target, package metadata, entry point facts | build graph는 compilation unit과 provider invalidation을 결정한다 | config/build 변경 시 관련 shard만 invalidate | mtime-only stale 판단 또는 전체 rebuild 의존 |
| [ ] | provider invalidation | provider contract manifest | provider input/config/env/dependency fingerprint를 저장한다 | timeout/stale provider는 exact만 degrade, MayGraph 보존 | provider 실패가 graph 전체 실패 또는 stale exact 유지 |
| [ ] | Python provider | parser + Pyright/stub/Django-compatible type facts | imports, scopes, MRO, descriptors, annotations, `Self`, Protocol, dynamic attrs를 fact로 분리한다 | neutral Python fixture와 real census에서 `missing=0`, `under=0` | `Self` global symbol merging, duck-typing heuristic exact |
| [ ] | Django provider | app registry/model/queryset/manager/migration/template facts | ORM field/relation/reverse/queryset/manager/template/URL surface를 framework namespace로 저장한다 | reverse relation and queryset fixture에서 missed/under 0 | project model name, field name, corpus string 기반 hardcode |
| [ ] | TypeScript provider | TypeScript checker/project-reference/package-export facts | value/type/namespace, module resolution, JSX, declaration merge, `any` boundary를 분리한다 | checker oracle fixture에서 exact promotion evidence 존재 | type-only/runtime edge 혼합, untyped JS를 exact 처리 |
| [ ] | JVM/Spring provider | compiler/classpath/annotation/DI/web facts | Java/Kotlin hierarchy, overload, generated members, Spring bean/route/repository를 fact로 저장한다 | missing classpath/conditional bean은 `MAY`로 degrade | reflection/profile-dependent edge를 static exact 처리 |
| [ ] | Rust/Go/C++/.NET provider slots | provider contracts and minimum Tier 0/1 adapters | 아직 full provider가 없어도 source universe, declarations, imports/includes, unsupported diagnostics를 제공한다 | 각 언어 fixture에서 silent missing 0 | provider 미구현 언어를 discovery에서 누락 |
| [ ] | schema/API provider | SQL/OpenAPI/GraphQL/Protobuf schema facts | schema namespace와 code namespace를 분리하고 bridge fact로만 연결한다 | same-name code/schema fixture에서 false bridge 0 | raw string 또는 같은 이름으로 code usage 생성 |
| [ ] | template/config/infra provider | template/context/config/deployment facts | docs/config/template/IaC는 별도 namespace로 저장한다 | doc/string/config mention이 normal usage count에 들어가지 않음 | plain string이 callable/member usage로 fan-out |
| [ ] | call graph projection | caller/callee adjacency from call/construct/framework dispatch | caller/callee는 call edge projection이며 usage와 분리한다 | call detail과 usage detail의 provenance가 분리됨 | usage count를 caller/callee로 재사용 |
| [ ] | implementation graph projection | implements/overrides/framework implementation table | implementation은 hierarchy/framework contract에서만 생성한다 | same method name unrelated classes fixture에서 impl false positive 0 | same-name method로 implementation fan-out |
| [ ] | runtime observation | `RuntimeObservedEdgeFact` and observed-only bucket | runtime trace는 `OBSERVED`이며 static `MAY`를 삭제하지 않는다 | observed edge가 static count exact를 혼자 바꾸지 않음 | trace/log evidence로 static `MUST` 생성 |
| [ ] | MCP reconnect | endpoint rediscovery on reconnect/startup | client/server 재연결 시 저장된 포트를 믿지 않고 현재 endpoint를 탐색한다 | MCP restart 후 health/tools/list 자동 복구 | stale port cache로 transport closed 지속 |
| [ ] | independent validation | `rg`/compiler/LSP/full census reports | graph output으로 graph를 검증하지 않는다 | report에 `total,present,missing,missed,under,exact,over` 포함 | MCP graph 결과를 oracle로 사용 |
| [ ] | performance benchmark | warmed count/query/update benchmarks | query path는 materialized shard만 읽고 성능 회귀를 고정한다 | 100k count `<=10s`, single count `<=50ms p95` | exact 개선 후 count latency 회귀 |
| [ ] | regression fixture policy | neutral fixtures per rule | fixture는 언어/프레임워크 구조를 나타내며 프로젝트 도메인 이름을 쓰지 않는다 | fixture grep에서 benchmark corpus/domain names 0 | project-specific symbol/string hardcode |
| [ ] | release gate | CI/report acceptance gate | `missing=0`, `missed=0`, `under=0` 유지 후 exact 개선을 허용한다 | overcount 감소 PR도 세 조건 유지 | exact 상승을 위해 undercount/missing 발생 |

Provider readiness rule:

- Tier 0/1이 없는 provider는 exact-producing provider가 될 수 없다.
- Tier 2+ provider는 실패해도 Tier 0/1 `MAY` upper를 축소할 수 없다.
- provider별 matrix row는 "구현됨"이 아니라 "independent oracle로 검증됨"일 때만 완료 처리한다.
- 새로운 언어/프레임워크는 이 matrix에 row를 추가한 뒤 구현한다.

## Design Checklist

- [ ] 프로젝트 domain name을 사용하지 않았다.
- [ ] benchmark corpus 문자열로 rule을 만들지 않았다.
- [ ] fallback edge는 exact로 승격되지 않는다.
- [ ] count query는 sidecar만 읽는다.
- [ ] `MAY`가 ground truth보다 작아지지 않는다.
- [ ] binary/image/generated 파일은 graph analysis 대상에서 제외된다.
- [ ] stale 판정과 shard commit이 generation manifest로 재현 가능하다.
- [ ] MCP reconnect는 port rediscovery를 수행한다.

## References

- Google Kythe overview: https://kythe.io/docs/kythe-overview.html
- Kythe compilation database: https://kythe.io/docs/kythe-compilation-database.html
- Google Code Search cross-references: https://developers.google.com/code-search/user/cross-references
- GitHub code navigation: https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github
- GitHub Stack Graphs: https://github.blog/open-source/introducing-stack-graphs/
- GitHub Code Search architecture: https://github.blog/engineering/the-technology-behind-githubs-new-code-search/
- Python data model: https://docs.python.org/3/reference/datamodel.html
- TypeScript module reference: https://www.typescriptlang.org/docs/handbook/modules/reference.html
- Java Language Specification, classes: https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html
- Rust reference, modules: https://doc.rust-lang.org/reference/items/modules.html
- Go language specification: https://go.dev/ref/spec
- clangd compile commands: https://clangd.llvm.org/design/compile-commands
- Django model documentation: https://docs.djangoproject.com/en/5.2/topics/db/models/
- Spring Framework IoC container: https://docs.spring.io/spring-framework/reference/core/beans.html
- GraphQL specification: https://spec.graphql.org/draft/
- OpenAPI specification: https://spec.openapis.org/oas/latest.html
- Protocol Buffers proto3 guide: https://protobuf.dev/programming-guides/proto3/
- Kubernetes objects: https://kubernetes.io/docs/concepts/overview/working-with-objects/
