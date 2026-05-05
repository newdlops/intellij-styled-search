# Codex 구현 사양서: Rust 기반 Multi-language Usage / Implementation Inlay Indexer

## 0. 문서 목적

이 문서는 VSCode Extension에서 사용할 Rust 기반 색인기를 Codex가 구현하기 위한 요구사항 사양이다. 구현 대상은 Python, TypeScript, TSX, React, GraphQL, Django, Java, Spring 코드베이스에서 함수, 클래스, enum, constant, struct, type, interface 등의 usage와 implementation을 색인하고, VSCode inlay hint로 표시하는 시스템이다.

이 문서는 실제 구현 코드가 아니라 Codex가 구현해야 할 구조, 데이터 모델, 분석 패스, 언어별 검사 항목, 런타임 관찰 요구사항, 테스트 기준을 정의한다.

---

## 1. 핵심 목표

### 1.1 반드시 달성해야 하는 목표

1. Rust core를 중심으로 multi-language static indexer를 구현한다.
2. VSCode Extension에서는 Rust LSP 또는 Rust backend를 호출하여 inlay hint를 표시한다.
3. Python, TypeScript, TSX, React, GraphQL, Django, Java, Spring의 usage와 implementation을 최대한 누락 없이 색인한다.
4. 정의가 여러 줄에 걸쳐 있거나 중간에 주석, decorator, annotation, modifier, generic, type parameter가 끼어도 놓치지 않는다.
5. 정규식 기반 definition 검색을 기본 방식으로 사용하지 않는다.
6. CST 또는 AST 기반 range를 사용한다.
7. static analysis로 확정 가능한 edge와 runtime observation으로 확인된 edge를 구분해서 저장한다.
8. unresolved dynamic usage도 버리지 않고 별도 edge로 저장한다.
9. inlay hint는 현재 열린 문서와 visible range에 대해 빠르게 계산한다.
10. symbol, reference, implementation, runtime-observed edge를 모두 검색 가능하게 저장한다.

### 1.2 비목표

1. 모든 언어에 대해 완전한 type checker를 Rust에서 처음부터 직접 구현하지 않는다.
2. 외부 compiler, language server, runtime hook, framework metadata dump를 사용할 수 있다.
3. extension이 사용자 동의 없이 임의의 애플리케이션 코드를 실행하지 않는다.
4. runtime observation은 선택 기능이며 기본값은 off로 둔다.
5. formatter, linter, code action 기능은 본 사양의 범위가 아니다.

---

## 2. 기본 아키텍처

### 2.1 권장 workspace 구조

다음 Rust workspace 구조를 기준으로 구현한다.

```text
multi_inlay_indexer/
  crates/
    indexer-core/
    indexer-storage/
    indexer-lsp/
    indexer-vscode-bridge/
    lang-python/
    lang-typescript/
    lang-graphql/
    lang-java/
    framework-django/
    framework-react/
    framework-spring/
    runtime-python/
    runtime-node/
    runtime-java/
    runtime-graphql/
    test-fixtures/
  vscode-extension/
    package.json
    src/
    syntaxes/
    README.md
  docs/
    architecture.md
    limitations.md
```

### 2.2 모듈 책임

| 모듈 | 책임 |
|---|---|
| `indexer-core` | symbol, edge, scope, document, range, parser abstraction, index orchestration |
| `indexer-storage` | SQLite 또는 embedded DB 기반 symbol/edge 저장소 |
| `indexer-lsp` | LSP server, inlayHint provider, diagnostics, workspace notifications |
| `indexer-vscode-bridge` | VSCode extension과 Rust backend 연결 |
| `lang-python` | Python CST/AST 분석, symbol/ref 추출, Python-specific resolution |
| `lang-typescript` | TS/TSX/JSX 분석, import/export/module resolution, optional TS checker adapter |
| `lang-graphql` | GraphQL SDL, operation, fragment, directive, resolver mapping 분석 |
| `lang-java` | Java AST 분석, classpath-aware symbol/ref 추출, hierarchy/override edge |
| `framework-django` | Django URLConf, model, ORM, signal, template, admin/form/serializer edge |
| `framework-react` | React component, JSX, hooks, HOC, context edge |
| `framework-spring` | Spring bean, DI, route, event, scheduled, AOP, actuator merge edge |
| `runtime-*` | 선택적 런타임 관찰기 및 static index와의 merge |

---

## 3. 전체 색인 파이프라인

### 3.1 파이프라인 개요

```text
1. Workspace discovery
2. File classification
3. Config discovery
4. Parse
5. Definition pass
6. Scope pass
7. Reference pass
8. Symbol resolution pass
9. Implementation pass
10. Framework pass
11. Runtime observation merge
12. Inlay hint materialization
13. Incremental update
```

### 3.2 Workspace discovery

다음을 감지한다.

```text
공통:
  - workspace root
  - git root
  - .gitignore
  - editor exclude setting
  - generated file 후보
  - vendored dependency 후보
  - monorepo package root

Python:
  - pyproject.toml
  - setup.cfg
  - setup.py
  - requirements*.txt
  - manage.py
  - Django settings module 후보
  - venv, .venv 제외

TypeScript / JavaScript / React:
  - package.json
  - tsconfig.json
  - jsconfig.json
  - pnpm-workspace.yaml
  - yarn.lock
  - package-lock.json
  - turbo.json
  - vite.config.*
  - webpack.config.*
  - next.config.*

GraphQL:
  - schema.graphql
  - *.graphql
  - *.gql
  - codegen.ts
  - codegen.yml
  - graphql.config.*
  - relay config

Java / Spring:
  - pom.xml
  - build.gradle
  - build.gradle.kts
  - settings.gradle
  - settings.gradle.kts
  - src/main/java
  - src/test/java
  - generated-sources
  - application.yml
  - application.properties
```

### 3.3 File classification

파일을 다음 기준으로 분류한다.

```text
source_language:
  - python
  - typescript
  - tsx
  - javascript
  - jsx
  - graphql
  - java
  - xml
  - yaml
  - properties
  - template

file_role:
  - source
  - test
  - generated
  - declaration
  - config
  - dependency
  - template
  - schema
  - operation
```

`generated`와 `dependency`는 기본적으로 low-priority로 색인하되, public API와 declaration reference는 필요 시 포함한다.

---

## 4. Parser 및 Range 요구사항

### 4.1 Parser 원칙

1. 정의와 참조는 정규식이 아니라 CST/AST node에서 추출한다.
2. parser는 syntax error가 있어도 partial tree를 제공해야 한다.
3. tree-sitter 또는 언어별 compiler AST를 사용할 수 있다.
4. comment, whitespace, decorator, annotation, modifier, generic, JSX, GraphQL template literal을 고려한다.
5. multiline definition과 중간 comment는 정상 케이스로 취급한다.

### 4.2 Range 저장 규칙

모든 symbol과 edge는 다음 range를 저장한다.

```text
file_id
byte_start
byte_end
line_start
column_start_utf8
line_end
column_end_utf8
lsp_line_start
lsp_character_start_utf16
lsp_line_end
lsp_character_end_utf16
```

### 4.3 Symbol range 종류

각 symbol은 다음 range를 가능하면 모두 가진다.

```text
name_range:
  이름 자체의 range.
  예: Foo, userName, User.id, Query.user

selection_range:
  VSCode selection과 hover 기준으로 쓰는 짧은 range.
  일반적으로 name_range와 동일하다.

definition_range:
  decorator, annotation, modifier, type parameter, signature, body header를 포함한 전체 정의 range.
  multiline signature와 중간 comment를 포함해야 한다.

body_range:
  function/class/method body가 있으면 body range.
  body가 없으면 null.

leading_doc_range:
  docstring, JSDoc, JavaDoc, GraphQL description이 있으면 저장한다.
```

### 4.4 UTF-16 변환 요구사항

VSCode/LSP position은 UTF-16 character offset을 사용한다. 내부 저장은 UTF-8 byte offset을 유지하되 LSP 응답 직전 UTF-16 range로 변환한다.

반드시 테스트해야 할 문자:

```text
한글
이모지
combining character
CRLF
BOM
Tab
```

---

## 5. 핵심 데이터 모델

### 5.1 Document

```text
Document:
  id
  workspace_id
  absolute_path
  relative_path
  uri
  language
  file_role
  content_hash
  mtime
  parser_version
  indexed_at
  syntax_error_count
```

### 5.2 Symbol

```text
Symbol:
  id
  workspace_id
  document_id
  language
  kind
  name
  qualified_name
  display_name
  container_symbol_id
  scope_id
  exported
  public_visibility
  generated
  synthetic
  framework_created
  runtime_created
  confidence
  name_range
  selection_range
  definition_range
  body_range
  leading_doc_range
  metadata_json
```

### 5.3 SymbolKind

```text
Module
Package
Namespace
Function
AsyncFunction
GeneratorFunction
Method
Constructor
Class
AbstractClass
Interface
Protocol
Enum
EnumMember
Struct
Record
AnnotationType
Constant
Variable
Field
Property
Parameter
TypeParameter
TypeAlias
GraphQLSchema
GraphQLType
GraphQLInterface
GraphQLUnion
GraphQLInput
GraphQLEnum
GraphQLEnumValue
GraphQLScalar
GraphQLDirective
GraphQLField
GraphQLArgument
GraphQLOperation
GraphQLFragment
Route
Bean
Resolver
Template
Unknown
```

### 5.4 Edge

```text
Edge:
  id
  workspace_id
  document_id
  from_symbol_id
  to_symbol_id
  edge_kind
  language
  range
  static_or_runtime
  confidence
  resolution_status
  metadata_json
```

### 5.5 EdgeKind

```text
Defines
References
Reads
Writes
Deletes
Calls
Constructs
Imports
Exports
Reexports
Extends
Implements
Overrides
Overloads
Decorates
Annotates
TypeReferences
MemberAccess
IndexAccess
RoutesTo
ResolvesGraphQLField
ImplementsGraphQLField
Injects
ProvidesBean
ConsumesBean
HandlesEvent
Schedules
AopAdvises
TemplateReferences
RuntimeObservedCall
RuntimeObservedImport
RuntimeObservedRoute
RuntimeObservedResolver
RuntimeObservedBean
UnresolvedDynamicReference
```

### 5.6 ConfidenceLevel

```text
StaticCertain:
  parser와 resolver로 확정된 edge.

StaticProbable:
  이름, 구조, framework convention으로 높은 확률로 추론된 edge.

FrameworkInferred:
  Django, React, Spring, GraphQL 규칙으로 연결된 edge.

RuntimeObserved:
  실행 중 관찰된 edge.

UnresolvedDynamic:
  dynamic string, reflection, eval, import hook 등으로 감지했지만 target을 확정하지 못한 edge.
```

### 5.7 Scope

```text
Scope:
  id
  document_id
  parent_scope_id
  owner_symbol_id
  kind
  range
```

```text
ScopeKind:
  Workspace
  Module
  Package
  Class
  Interface
  Function
  Method
  Block
  Comprehension
  Lambda
  GraphQLSchema
  GraphQLOperation
```

---

## 6. 공통 분석 패스 사양

### 6.1 Definition pass

다음을 definition 후보로 추출한다.

```text
module/package/file
import alias
export alias
function
async function
generator function
method
constructor
accessor
property
class
abstract class
interface
type alias
enum
enum member
namespace
struct
record
annotation type
field
constant
parameter
type parameter
local variable
destructuring binding
pattern binding
annotation/decorator-created symbol
framework registration-created symbol
generated symbol
```

주의사항:

1. assignment로 만들어진 함수와 클래스도 definition으로 본다.
2. framework registration으로 만들어진 route, bean, resolver도 synthetic definition으로 저장한다.
3. import binding도 현재 파일 scope의 definition이다.
4. `export { Foo as Bar }`에서는 `Bar`를 export alias symbol로 저장한다.

### 6.2 Scope pass

다음을 처리한다.

```text
lexical scope 생성
class/function/module/block scope 생성
import binding 등록
parameter binding 등록
local binding 등록
shadowing 처리
global/nonlocal 처리
this/self/super 처리
closure capture 후보 처리
```

### 6.3 Reference pass

다음을 usage 후보로 추출한다.

```text
identifier read
identifier write
identifier delete
call target
constructor target
member access
index/key access
import source
export source
decorator / annotation
type annotation
generic type argument
base class
implements clause
extends clause
JSX tag
JSX prop
GraphQL selection
GraphQL fragment spread
GraphQL directive
GraphQL variable
string literal framework reference
template literal framework reference
reflection reference
DI reference
route reference
resolver reference
signal/event reference
```

### 6.4 Resolution pass

다음 순서로 symbol을 해결한다.

```text
1. lexical scope lookup
2. container scope lookup
3. module-level binding lookup
4. import/export resolution
5. package/module resolution
6. type checker or symbol solver result merge
7. inheritance/member lookup
8. framework-specific resolution
9. runtime-observed edge merge
10. unresolved dynamic edge fallback
```

### 6.5 Implementation pass

implementation edge는 다음을 포함한다.

```text
class implements interface
class extends abstract class
method overrides superclass method
method implements interface method
record implements interface
GraphQL resolver implements schema field
Django view implements URL route
Django model implements framework model contract
Spring bean provides injection target
Spring controller method implements route mapping
Spring event listener implements event handler
Spring scheduled method implements scheduled task
React component implements JSX value element
```

---

## 7. Python 분석 사양

### 7.1 Python definition 추출

반드시 추출할 definition:

```text
FunctionDef
AsyncFunctionDef
ClassDef
Lambda assigned to a name
Assign
AnnAssign
AugAssign target
TypeAlias
Import alias
ImportFrom alias
function parameters
positional-only parameters
keyword-only parameters
*args
**kwargs
for target
async for target
with ... as target
async with ... as target
except ... as target
match-case capture pattern
comprehension local binding
class attribute
instance attribute self.x
Enum member
dataclass field
attrs field
pydantic field
property
cached_property
```

### 7.2 Python usage 추출

반드시 추출할 usage:

```text
Name with Load context
Name with Store context
Name with Del context
Attribute access
Call target
decorator expression
base class expression
metaclass expression
annotation expression
string forward reference annotation
typing constructs
getattr(obj, "name")
setattr(obj, "name", value)
hasattr(obj, "name")
globals()["name"]
locals()["name"]
importlib.import_module("module")
__import__("module")
__all__
module monkey patch: module.name = value
```

### 7.3 Python dynamic 처리

다음은 `UnresolvedDynamicReference` 또는 `StaticProbable`로 저장한다.

```text
eval(...)
exec(...)
getattr with non-literal name
setattr with non-literal name
importlib.import_module with non-literal module
__import__ with non-literal module
dynamic module attribute assignment
decorator wrapper without __wrapped__
```

### 7.4 Django 분석

#### settings 분석

```text
INSTALLED_APPS
ROOT_URLCONF
MIDDLEWARE
TEMPLATES
AUTH_USER_MODEL
DEFAULT_AUTO_FIELD
DATABASES
REST_FRAMEWORK
```

#### URLConf 분석

```text
urlpatterns
path(...)
re_path(...)
include(...)
namespace
app_name
route name
function view
class-based view .as_view()
redirect view
static file helper route
```

생성할 edge:

```text
Route --RoutesTo--> ViewFunction
Route --RoutesTo--> ClassBasedView
Route --References--> route name string
include route --References--> child URLConf module
```

#### View 분석

```text
function view
class-based view
get/post/put/delete/patch/head/options/trace
dispatch
login_required
permission_required
csrf decorators
cache decorators
DRF APIView/ViewSet/action
```

#### Model/ORM 분석

```text
Model subclass
Field definitions
ForeignKey("app.Model")
ForeignKey("self")
ManyToManyField
OneToOneField
related_name
related_query_name
Manager
QuerySet method
Meta options
filter(field__lookup=...)
exclude(field__lookup=...)
get(field__lookup=...)
values("field")
values_list("field")
order_by("field")
select_related("relation")
prefetch_related("relation")
F("field")
Q(...)
annotate(alias=...)
aggregate(alias=...)
```

#### Signals 분석

```text
@receiver(signal, sender=...)
signal.connect(receiver, sender=...)
dispatch_uid
pre_save
post_save
pre_delete
post_delete
m2m_changed
request_started
request_finished
```

생성할 edge:

```text
Signal --HandlesEvent--> ReceiverFunction
Model --References--> SignalReceiver
```

#### Template 분석

```text
{% url "route-name" %}
{% include "template.html" %}
{% extends "base.html" %}
{% load taglib %}
custom template tags
custom template filters
context variable usage
```

---

## 8. TypeScript / TSX / React 분석 사양

### 8.1 TypeScript project resolution

다음을 반영한다.

```text
tsconfig.json
jsconfig.json
compilerOptions.baseUrl
compilerOptions.paths
compilerOptions.references
compilerOptions.rootDirs
compilerOptions.typeRoots
compilerOptions.types
compilerOptions.jsx
compilerOptions.allowJs
compilerOptions.checkJs
compilerOptions.module
compilerOptions.moduleResolution
package.json type
package.json exports
package.json imports
package.json main
package.json module
package.json browser
package.json types
declaration files .d.ts
project references
workspace packages
node_modules/@types
```

### 8.2 TypeScript definition 추출

```text
function declaration
function expression assigned to name
arrow function assigned to name
class declaration
abstract class
interface
type alias
enum
const enum
namespace
module declaration
var/let/const
destructuring binding
import binding
export binding
default export
re-export
class field
method
accessor
constructor
parameter property
parameter
type parameter
mapped type parameter
infer type variable
overload signature
implementation signature
ambient declare
module augmentation
global augmentation
```

### 8.3 TypeScript usage 추출

```text
Identifier in expression position
Identifier in type position
PropertyAccessExpression
ElementAccessExpression
CallExpression
NewExpression
TaggedTemplateExpression
Decorator
ImportDeclaration
ExportDeclaration
ExportAssignment
export * from
export { X } from
import("module")
require("module")
require.resolve("module")
module.exports
exports.foo
JSX tag name
JSX prop name
JSX expression container
JSX spread prop
type query typeof Foo
indexed access type T["x"]
keyof
satisfies
as assertion
const assertion
conditional type
mapped type
JSDoc type import
```

### 8.4 TypeScript semantic adapter

가능하면 TypeScript compiler API 또는 tsserver-compatible sidecar를 사용한다.

필요 결과:

```text
symbol at node
declarations of symbol
type at node
type of symbol
aliased symbol
resolved module name
overload resolution
JSX intrinsic vs value element 판단
```

Rust core는 sidecar 결과를 `ExternalSemanticFact`로 받아 symbol/edge DB에 merge한다.

### 8.5 TSX / JSX / React 분석

#### JSX tag resolution

```text
lowercase tag:
  intrinsic element로 처리한다.
  예: <div>, <span>

uppercase tag:
  value symbol reference로 처리한다.
  예: <UserCard />

member expression tag:
  namespace/member chain으로 처리한다.
  예: <Foo.Bar />

fragment:
  React.Fragment 또는 jsx runtime fragment로 처리한다.
```

#### React component definition

```text
function Component(...)
const Component = (...)
const Component = function (...)
export default function Component(...)
class Component extends React.Component
class Component extends Component
memo(Component)
forwardRef(...)
lazy(() => import(...))
observer(Component)
connect(...)(Component)
styled(Component)
HOC returned component
```

#### React usage

```text
JSX component usage
props usage
spread props
children
key
ref
context Provider
context Consumer
useContext(Context)
useState
useReducer
useMemo
useCallback
useEffect dependency array
custom hook useXxx
React Router route component usage
Next.js page/app route convention, optional
```

생성할 edge:

```text
JSXElement --References--> ComponentSymbol
Component --Reads--> prop field
Component --Calls--> hook
ContextConsumer --References--> ContextProvider
lazy wrapper --RuntimeObservedImport or StaticProbable--> imported component
```

---

## 9. GraphQL 분석 사양

### 9.1 GraphQL source 감지

다음을 모두 감지한다.

```text
*.graphql
*.gql
schema.graphql
GraphQL SDL string
gql`...`
graphql`...`
/* GraphQL */ `...`
Apollo Client documents
Relay documents
urql documents
generated DocumentNode
codegen document paths
```

### 9.2 GraphQL definition 추출

```text
schema definition
type
extend type
interface
union
input
enum
enum value
scalar
directive definition
field definition
argument definition
operation definition
fragment definition
variable definition
```

### 9.3 GraphQL usage 추출

```text
field selection
field alias
argument name
variable usage
fragment spread
inline fragment type condition
directive usage
enum value usage
input object field usage
schema type reference
```

### 9.4 GraphQL field symbol key

GraphQL field는 반드시 parent type과 함께 식별한다.

```text
GraphQLFieldKey:
  schema_id
  parent_type_name
  field_name
```

예:

```text
User.id != Post.id
Query.user != User.user
```

### 9.5 GraphQL alias 처리

```graphql
query {
  me: user(id: "1") {
    name
  }
}
```

처리 규칙:

```text
alias "me": operation-local output alias symbol
field "user": Query.user field usage
```

alias를 schema field usage로 잘못 저장하면 안 된다.

### 9.6 Resolver implementation mapping

다음을 resolver implementation으로 연결한다.

```text
Apollo resolver map:
  Query.user
  Mutation.createUser
  User.posts

GraphQL Java:
  RuntimeWiring
  DataFetcher
  TypeResolver
  custom scalar

Spring GraphQL:
  @QueryMapping
  @MutationMapping
  @SubscriptionMapping
  @SchemaMapping
  @Argument
```

생성할 edge:

```text
GraphQLField --ImplementsGraphQLField--> ResolverFunction
GraphQLType --References--> TypeResolver
GraphQLScalar --References--> ScalarImplementation
GraphQLOperation --References--> GraphQLField
GraphQLFragment --References--> GraphQLType
```

---

## 10. Java 분석 사양

### 10.1 Java project discovery

다음을 감지한다.

```text
pom.xml
build.gradle
build.gradle.kts
settings.gradle
settings.gradle.kts
src/main/java
src/test/java
src/main/resources
src/test/resources
target/generated-sources
build/generated
annotation processor output
module-info.java
META-INF/services
classpath
source compatibility
JDK version
```

### 10.2 Java definition 추출

```text
package declaration
import
static import
class
abstract class
interface
enum
record
annotation type @interface
sealed class/interface
permits clause
field
static final constant
enum constant
method
constructor
compact record constructor
initializer block
static initializer block
annotation member
type parameter
method type parameter
parameter
local variable
catch parameter
try-with-resources variable
lambda parameter
nested class
nested interface
nested enum
nested record
```

### 10.3 Java usage 추출

```text
type reference
constructor call new Foo()
method call
overloaded method call
field access
static member access
method reference Foo::bar
constructor reference Foo::new
lambda target functional interface
annotation usage
annotation attribute value
class literal Foo.class
generic type argument
wildcard bound
extends
implements
throws
permits
record component type
import
static import
switch enum constant
Class.forName("...")
ServiceLoader.load(...)
META-INF/services implementation
JNI/native method name
```

### 10.4 Java implementation resolution

다음을 구현한다.

```text
class extends superclass
class implements interface
interface extends interface
method overrides superclass method
method implements interface method
abstract method implementation
default method override
record implements interface
sealed permits relation
annotation processor generated class relation
ServiceLoader provider relation
```

주의사항:

```text
overload resolution은 parameter type 기준으로 처리한다.
generic erasure와 bridge method는 metadata로 보존한다.
method reference는 functional interface target을 함께 저장한다.
lambda는 target functional interface method implementation으로 볼 수 있다.
```

---

## 11. Spring 분석 사양

### 11.1 Bean definition 분석

다음을 bean 또는 bean 후보로 추출한다.

```text
@Component
@Service
@Repository
@Controller
@RestController
@Configuration
@Bean
@Import
@ComponentScan
@ConfigurationProperties
FactoryBean
XML bean definition, optional
```

생성할 edge:

```text
Class --ProvidesBean--> BeanSymbol
@Bean method --ProvidesBean--> BeanSymbol
@Configuration --References--> @Bean methods
```

### 11.2 Dependency injection 분석

다음을 injection usage로 추출한다.

```text
@Autowired
@Inject
@Resource
@Qualifier
@Primary
@Profile
@Conditional*
constructor injection
field injection
setter injection
ApplicationContext.getBean(...)
BeanFactory.getBean(...)
```

생성할 edge:

```text
InjectionPoint --ConsumesBean--> BeanSymbol
BeanSymbol --Injects--> DependencyBeanSymbol
```

### 11.3 Spring MVC route 분석

다음을 route implementation으로 추출한다.

```text
@RequestMapping
@GetMapping
@PostMapping
@PutMapping
@DeleteMapping
@PatchMapping
@PathVariable
@RequestParam
@RequestBody
@ResponseBody
@RestController
@Controller
@ControllerAdvice
@ExceptionHandler
WebFlux RouterFunction, optional
```

route key는 다음을 포함한다.

```text
http_method
class_level_path
method_level_path
params condition
headers condition
consumes
produces
controller_class
handler_method
```

생성할 edge:

```text
Route --RoutesTo--> ControllerMethod
RequestParam --References--> MethodParameter
PathVariable --References--> MethodParameter
RequestBody --References--> DTOType
```

### 11.4 Spring event, schedule, AOP 분석

다음을 direct call이 없어도 implementation으로 표시한다.

```text
@Scheduled
@EventListener
@TransactionalEventListener
ApplicationListener<T>
ApplicationEventPublisher.publishEvent(...)
@Transactional
@Async
@Cacheable
@CacheEvict
@CachePut
@PreAuthorize
@PostAuthorize
@Aspect
@Pointcut
@Before
@After
@Around
@AfterReturning
@AfterThrowing
```

생성할 edge:

```text
ScheduledTask --Schedules--> Method
EventType --HandlesEvent--> ListenerMethod
Aspect --AopAdvises--> JoinPointCandidate
TransactionalProxy --References--> TargetMethod
```

### 11.5 Spring runtime merge

옵션으로 다음 runtime source를 merge한다.

```text
/actuator/beans
/actuator/mappings
/actuator/scheduledtasks
/actuator/configprops
ApplicationContext bean dump
AOP proxy target class dump
```

runtime에서 얻은 proxy class는 원본 target class와 interface symbol로 normalize한다.

---

## 12. Runtime observation 사양

### 12.1 공통 원칙

1. Runtime observation은 opt-in이다.
2. extension은 사용자 동의 없이 앱을 실행하지 않는다.
3. runtime 수집 데이터에는 secret, request body, token, password를 저장하지 않는다.
4. runtime edge는 `RuntimeObserved` confidence로 저장한다.
5. static edge와 runtime edge가 같은 target을 가리키면 merge하고 observed count를 증가시킨다.
6. static edge와 runtime edge가 충돌하면 둘 다 저장하고 conflict metadata를 남긴다.

### 12.2 Python runtime adapter

수집 대상:

```text
function call
method call
module import
actual imported module path
Django URL resolver table
Django app registry
Django model registry
Django signal receivers
Django template load
```

사용 가능한 방식:

```text
sys.setprofile
sys.settrace
import hook
Django management command wrapper
Django startup metadata dump
```

### 12.3 Node / TypeScript runtime adapter

수집 대상:

```text
actual module resolution
ESM import
CommonJS require
dynamic import
function execution coverage
React component render, optional
GraphQL operation execution, optional
```

사용 가능한 방식:

```text
node --import hook
node --require hook
node:module customization hook
V8 precise coverage
source map remapping
Babel/Vite/Webpack plugin, optional
```

### 12.4 Java / Spring runtime adapter

수집 대상:

```text
class load
method execution
actual bean registration
actual injected bean
actual request mapping
actual scheduled task
actual event listener
AOP proxy target
```

사용 가능한 방식:

```text
javaagent
ClassFileTransformer
ASM or ByteBuddy instrumentation
Spring ApplicationContext dump
Spring Boot Actuator endpoints
```

### 12.5 GraphQL runtime adapter

수집 대상:

```text
operation name
operation document hash
field resolver path
actual resolver function/method
argument names without sensitive values
execution count
error path
```

사용 가능한 방식:

```text
Apollo Server plugin lifecycle
GraphQL Java Instrumentation
Spring GraphQL DataFetcher instrumentation
```

---

## 13. Inlay Hint 사양

### 13.1 표시 대상

다음 symbol definition 위치에 inlay hint를 표시한다.

```text
function
method
class
interface
type alias
enum
struct
record
constant
field
GraphQL type
GraphQL field
GraphQL operation
Django route
Spring route
Spring bean
React component
```

### 13.2 기본 label

기본 label 형식:

```text
refs:N
impl:M
rt:K
```

예:

```text
refs:12 impl:3 rt:5
```

의미:

```text
refs:
  static-certain + static-probable + framework-inferred usage count

impl:
  implementation edge count

rt:
  runtime-observed edge count
```

### 13.3 confidence별 표시

설정으로 confidence threshold를 조절할 수 있어야 한다.

```text
indexer.inlay.minConfidence:
  StaticCertain
  StaticProbable
  FrameworkInferred
  RuntimeObserved
  UnresolvedDynamic
```

기본값:

```text
StaticProbable 이상 표시
UnresolvedDynamic은 tooltip에서만 표시
```

### 13.4 Tooltip 내용

Tooltip에는 다음을 포함한다.

```text
symbol name
qualified name
symbol kind
reference count by edge kind
implementation count by edge kind
runtime observed count
unresolved dynamic count
top reference locations
last indexed time
```

### 13.5 클릭 동작

가능하면 inlay label part에 location을 연결한다.

```text
refs 클릭:
  references quick pick 또는 virtual document 열기

impl 클릭:
  implementations quick pick 또는 virtual document 열기

rt 클릭:
  runtime observed edge 목록 열기
```

### 13.6 성능 요구사항

```text
visible range에 대해서만 즉시 계산한다.
큰 프로젝트에서는 전체 count를 background index 결과에서 읽는다.
문서 수정 중에는 debounce한다.
syntax error가 있어도 이전 index snapshot을 fallback한다.
```

---

## 14. Incremental indexing 사양

### 14.1 변경 이벤트

처리할 이벤트:

```text
file open
file change
file save
file delete
file rename
config file change
workspace folder add/remove
dependency lockfile change
runtime observation append
```

### 14.2 incremental update 규칙

```text
content_hash가 같으면 재색인하지 않는다.
parser tree incremental edit을 사용한다.
변경된 file의 symbol/edge만 우선 갱신한다.
import/export graph에서 영향을 받는 dependent file을 재해석한다.
framework graph는 관련 config 또는 registration file 변경 시 재계산한다.
runtime edge는 static symbol id 변경 시 remap을 시도한다.
remap 실패 시 orphan runtime edge로 보존한다.
```

### 14.3 stale 처리

```text
삭제된 file의 symbol은 tombstone 처리한다.
rename된 file은 content_hash와 old path로 remap한다.
range가 이동한 symbol은 name + container + fingerprint로 remap한다.
generated file은 source map 또는 generation metadata가 있으면 origin symbol에 연결한다.
```

---

## 15. 저장소 사양

### 15.1 기본 저장소

기본 저장소는 SQLite를 권장한다.

필수 index:

```text
symbols(workspace_id, document_id)
symbols(workspace_id, qualified_name)
symbols(workspace_id, kind)
symbols(workspace_id, name)
edges(workspace_id, from_symbol_id)
edges(workspace_id, to_symbol_id)
edges(workspace_id, edge_kind)
edges(workspace_id, document_id)
edges(workspace_id, static_or_runtime)
documents(workspace_id, relative_path)
documents(workspace_id, content_hash)
```

### 15.2 Query API

Rust core는 다음 query를 제공한다.

```text
get_symbol_at_position(document, position)
get_references(symbol_id, filters)
get_implementations(symbol_id, filters)
get_runtime_edges(symbol_id, filters)
get_inlay_hints(document, visible_range, settings)
get_unresolved_dynamic_edges(document or symbol)
get_framework_edges(symbol_id)
```

---

## 16. Error handling 및 Diagnostics

### 16.1 Parser error

```text
syntax error가 있어도 index를 완전히 중단하지 않는다.
partial tree에서 가능한 symbol/ref를 추출한다.
이전 성공 snapshot이 있으면 inlay hint에 fallback한다.
```

### 16.2 Resolver error

```text
module resolution 실패 시 UnresolvedDynamicReference 또는 unresolved import edge로 저장한다.
sidecar compiler error는 diagnostics로 표시하되 indexer process를 죽이지 않는다.
classpath/tsconfig 미해결은 workspace diagnostics에 기록한다.
```

### 16.3 Runtime adapter error

```text
runtime adapter 실패는 static index에 영향을 주지 않는다.
수집 로그는 별도 diagnostics channel에 기록한다.
secret이 포함될 수 있는 값은 저장하지 않는다.
```

---

## 17. 설정 사양

VSCode settings 예시 키:

```text
multiInlayIndexer.enabled
multiInlayIndexer.languages.python.enabled
multiInlayIndexer.languages.typescript.enabled
multiInlayIndexer.languages.graphql.enabled
multiInlayIndexer.languages.java.enabled
multiInlayIndexer.frameworks.django.enabled
multiInlayIndexer.frameworks.react.enabled
multiInlayIndexer.frameworks.spring.enabled
multiInlayIndexer.runtime.enabled
multiInlayIndexer.runtime.python.enabled
multiInlayIndexer.runtime.node.enabled
multiInlayIndexer.runtime.java.enabled
multiInlayIndexer.runtime.graphql.enabled
multiInlayIndexer.inlay.enabled
multiInlayIndexer.inlay.showRefs
multiInlayIndexer.inlay.showImpl
multiInlayIndexer.inlay.showRuntime
multiInlayIndexer.inlay.minConfidence
multiInlayIndexer.index.includeGenerated
multiInlayIndexer.index.includeDependencies
multiInlayIndexer.index.excludeGlobs
multiInlayIndexer.index.maxFileSizeMb
multiInlayIndexer.storage.path
multiInlayIndexer.debug.trace
```

기본값:

```text
runtime.enabled = false
includeDependencies = false
includeGenerated = false
inlay.showRefs = true
inlay.showImpl = true
inlay.showRuntime = true, but only if runtime.enabled
maxFileSizeMb = 5
```

---

## 18. 테스트 사양

### 18.1 공통 fixture 요구사항

각 언어별로 다음 fixture를 만든다.

```text
single file definition/reference
multi-file import/export
multiline definition
middle comment inside signature/declaration
unicode identifier or unicode comments
nested scope
shadowing
destructuring or pattern binding
generated file mapping, optional
syntax error partial index
```

### 18.2 Python fixture

```text
function with multiline parameters
async function
class with decorators
property/cached_property
dataclass fields
Enum members
forward reference annotation string
getattr literal
getattr dynamic
importlib.import_module literal
Django URLConf path/re_path/include
Django CBV as_view
Django model ForeignKey("app.Model")
Django ORM filter(field__lookup=...)
Django signal receiver
Django template url tag
```

### 18.3 TypeScript / TSX / React fixture

```text
function declaration
arrow function component
default export
re-export
interface/type alias/enum
class implements interface
method override
namespace/module augmentation
type-only import/export
dynamic import
require
JSX lowercase intrinsic
JSX uppercase component
JSX member component Foo.Bar
JSX spread props
memo/forwardRef/lazy
custom hook
useEffect dependency array
GraphQL gql template in TSX
```

### 18.4 GraphQL fixture

```text
schema type/interface/union/input/enum/scalar/directive
extend type
operation query/mutation/subscription
fragment spread
inline fragment
field alias
variable definition and usage
input object field
enum value
same field name on different parent types
Apollo resolver map
Spring @SchemaMapping resolver
GraphQL Java RuntimeWiring resolver
```

### 18.5 Java / Spring fixture

```text
class/interface/enum/record/annotation type
sealed class permits
static final constant
constructor
method overload
method override
implements interface
method reference Foo::bar
constructor reference Foo::new
lambda target functional interface
annotation attribute value
static import
Class.forName literal
ServiceLoader META-INF/services
Spring @Component/@Service/@Repository/@Controller
Spring @Bean
constructor/field/setter injection
@Qualifier/@Primary
@RequestMapping + @GetMapping
@PathVariable/@RequestParam/@RequestBody
@Scheduled
@EventListener
@Aspect/@Pointcut/@Around
Actuator beans/mappings merge fixture
```

### 18.6 Acceptance tests

다음 조건을 통과해야 한다.

```text
정의 이름 range가 정확해야 한다.
multiline definition의 definition_range가 전체 선언을 포함해야 한다.
중간 comment가 있어도 symbol 추출이 성공해야 한다.
usage count가 fixture expected count와 일치해야 한다.
implementation count가 fixture expected count와 일치해야 한다.
unresolved dynamic reference가 누락되지 않아야 한다.
range가 UTF-16 LSP position으로 정확히 변환되어야 한다.
file edit 후 incremental index가 stale edge를 제거해야 한다.
runtime edge merge 후 inlay rt count가 증가해야 한다.
```

---

## 19. 구현 마일스톤

### Milestone 0: 프로젝트 뼈대

```text
Rust workspace 생성
core data model 생성
storage abstraction 생성
LSP server skeleton 생성
VSCode extension launcher 생성
basic logging/diagnostics 생성
```

### Milestone 1: Core static index

```text
document store
range conversion
parser abstraction
symbol table
edge table
scope table
inlay hint query
snapshot-based incremental update
```

### Milestone 2: Language parser integration

```text
Python parser integration
TypeScript/TSX parser integration
GraphQL parser integration
Java parser integration
language별 definition pass
language별 reference pass
```

### Milestone 3: Resolution

```text
lexical scope resolver
import/export resolver
module/package resolver
TS semantic sidecar adapter
Java symbol solver adapter, optional
inheritance/override resolver
unresolved dynamic fallback
```

### Milestone 4: Framework adapters

```text
Django adapter
React adapter
GraphQL resolver adapter
Spring adapter
framework edge DB merge
```

### Milestone 5: Runtime adapters

```text
Python runtime collector
Node runtime collector
Java runtime collector
GraphQL runtime collector
runtime edge merge
privacy guard
opt-in settings
```

### Milestone 6: Quality and performance

```text
fixture suite
snapshot tests
range tests
incremental update tests
large workspace benchmark
diagnostics quality
VSCode UX polish
```

---

## 20. Codex 구현 지시

Codex는 다음 원칙으로 구현한다.

1. 먼저 `indexer-core`의 데이터 모델, range 변환, storage abstraction, LSP inlay API를 구현한다.
2. 그 다음 language별 parser adapter를 추가한다.
3. definition pass와 reference pass는 각 언어별 test fixture를 먼저 만들고 구현한다.
4. regex-only 구현은 금지한다. regex는 fallback heuristic 또는 framework string extraction 보조에만 사용할 수 있다.
5. 모든 symbol/edge에는 range와 confidence를 저장한다.
6. dynamic usage는 버리지 말고 `UnresolvedDynamicReference`로 저장한다.
7. framework adapter는 static analyzer와 별도 모듈로 유지한다.
8. runtime adapter는 opt-in으로 구현하고 static index와 분리한다.
9. inlay hint는 visible range 기준으로 빠르게 반환한다.
10. 구현 중 불확실한 semantic resolution은 `StaticProbable` 또는 `UnresolvedDynamic`으로 저장하고 metadata에 이유를 남긴다.

---

## 21. 외부 참고 문서

구현 중 다음 공식 문서를 참고한다.

```text
Tree-sitter Query Syntax
https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html

Language Server Protocol 3.17 Inlay Hint
https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/

TypeScript Compiler API
https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API

Django URL dispatcher
https://docs.djangoproject.com/en/6.0/topics/http/urls/

GraphQL Specification
https://spec.graphql.org/

Node.js node:module API
https://nodejs.org/api/module.html

Java ClassFileTransformer
https://docs.oracle.com/en/java/javase/25/docs/api/java.instrument/java/lang/instrument/ClassFileTransformer.html

Spring Boot Actuator endpoints
https://docs.spring.io/spring-boot/reference/actuator/endpoints.html

Spring Boot Actuator mappings endpoint
https://docs.spring.io/spring-boot/api/rest/actuator/mappings.html

Spring Boot Actuator beans endpoint
https://docs.spring.io/spring-boot/api/rest/actuator/beans.html
```
