# VSCode Monaco Editor 탈취 via Prototype Monkey-patch

## 배경

최신 VSCode (1.85+)는 workbench를 하나의 ESM 번들(`workbench.js`)로 말아서 제공한다. 결과적으로:

- `monaco` / `window.monaco` / `globalThis.monaco` 어디에도 없음
- AMD `require`, `webpack_require`, Node `require` 전부 renderer에서 접근 불가
- `_VSCODE_NLS_MESSAGES`, `_VSCODE_NLS_LANGUAGE`, `_VSCODE_FILE_ROOT`, `MonacoPerformanceMarks` — 의미 있는 글로벌은 이 몇 개뿐
- Trusted Types 정책이 `eval` / 문자열 기반 script 생성 차단
- `import('vscode-file://.../out/vs/editor/editor.main.js')` → 404 (개별 파일 형태로 존재하지 않음)
- `.monaco-editor` DOM 엘리먼트에도 widget/service 레퍼런스 attach되지 않음

즉 공개적으로 노출된 경로로는 **monaco API에 도달할 수 없다**.

## 목표

Renderer 안에서 "**실제로 동작하는 CodeEditorWidget 인스턴스**"를 특정 DOM 위치에 생성하는 것. 테마·폰트·확장·settings 전부 공유됨.

## 핵심 기법: Prototype 몽키패치 sniffing

VSCode의 DI container와 workbench는 서비스·widget을 내부적으로 네이티브 자료구조(`Map`/`WeakMap`/`Set`/`Array`)에 담아 관리한다. 이들 저장 operation을 패치해서 **지나가는 값을 duck-type으로 식별**하면 서비스/클래스 레퍼런스를 가로챌 수 있다.

### 훅 대상

Patch 설치 즉시 아래 프로토타입들을 감싼다:

- `Map.prototype.set`
- `WeakMap.prototype.set`
- `Set.prototype.add`
- `Array.prototype.push`
- `Reflect.construct` (거의 안 잡히지만 보조용)

### Duck-type 판정

| 대상 | 식별 서명 |
|---|---|
| `CodeEditorWidget` 인스턴스 | `layout`/`getModel`/`getDomNode`가 모두 function |
| `IInstantiationService` | `createInstance`/`invokeFunction` 함수 |
| `ICodeEditorService` | `listCodeEditors` 또는 `getActiveCodeEditor` 함수 |
| `IModelService` | `createModel`/`getModel`/`getModels` 전부 함수 |

### DI stub vs 실제 widget 구분

Boot 타임에 잡히는 것들 상당수는 **DI stub / no-op proxy**다. 특징:
- `Object.getOwnPropertyNames(widget)` 빈 배열
- `widget.getModel()`이 null 반환
- `widget.constructor`가 async function이나 bound native function (진짜 class가 아님)
- `getDomNode()?.tagName`이 undefined

**실제 widget 필터**:
```js
var isReal = typeof w.getModel === 'function'
          && w.getModel()
          && w.getModel().uri;
```

### 실제 widget 강제 생성

Boot 이후엔 새 widget 생성이 거의 없으므로, capture가 설치된 뒤에 **명시적으로 에디터를 하나 띄웠다가 닫는다**:

```ts
// 아무 workspace 파일 하나
await vscode.window.showTextDocument(uri, {
  viewColumn: vscode.ViewColumn.Beside,
  preserveFocus: true,
  preview: true,
});
await sleep(1000);
await vscode.commands.executeCommand('workbench.action.closeEditorsInGroup');
```

이 동작이 `Map.set`/`Array.push`로 실제 `CodeEditorWidget` + 관련 서비스들을 흘려보낸다.

## 진짜 Class 찾기

Captured `widget.constructor`는 DI 미들웨어 wrapper (async function)나 bound native function이어서 생성자로 쓸 수 없다. 실제 class는 **prototype chain**에서 찾는다:

```js
var p = Object.getPrototypeOf(widget);
while (p) {
  var keys = Object.getOwnPropertyNames(p);
  var hasL = keys.indexOf('layout') >= 0;
  var hasM = keys.indexOf('getModel') >= 0;
  var hasD = keys.indexOf('getDomNode') >= 0;
  if (hasL && hasM && hasD) {
    // 이 proto의 .constructor가 진짜 CodeEditorWidget class
    realClass = p.constructor;
    break;
  }
  p = Object.getPrototypeOf(p);
}
```

실제 프로젝트에서는 class 이름이 minified되어 `ts`(parent: `x`)로 나온다.

## Widget 생성

```js
var editor = instantiationService.createInstance(
  realClass,
  hostElement,
  {
    automaticLayout: true,
    readOnly: false,
    theme: 'vs-dark',
    minimap: { enabled: false },
  },
  { isSimpleWidget: false, contributions: [] }   // ← 필수
);
```

**중요**: 네 번째 인자 `widgetOptions` 누락하면 생성자에서 `Cannot read properties of undefined (reading 'telemetryData')` 에러. 빈 객체라도 반드시 전달.

`IInstantiationService`는 captured 글로벌 서비스를 써도 되지만, `widget[0]._instantiationService` (private 필드)를 쓰면 **같은 scope의 services**라 더 안정적이었다.

## Model 세팅

Widget 생성만으로는 내부 model이 null일 수 있다 (captured logs에서 `before model: null`). Captured `IModelService`로 직접 model 만들어 붙여야 함:

```js
var model = modelService.createModel(
  fileContent,           // string
  languageId             // e.g. 'javascript', 'python', 'plaintext'
  // 세 번째 인자 uri로 Uri 넘기면 VSCode가 이미 열어둔 model과 공유됨
);
editor.setModel(model);
editor.layout({ width, height });   // automaticLayout만 믿으면 초기 사이즈 놓침
```

URI 없이 생성한 model은 `inmemory://model/N` 자동 URI를 갖는 별개 인스턴스다. VSCode의 다른 탭과 편집 공유 안 됨. 편집 공유 원하면 URI를 포함해야 하지만 `Uri` 클래스 레퍼런스도 같은 기법으로 잡아야 한다.

## 성공 지표

`post-render` 로그에서:

```
viewLines=N (N > 0)
innerHTML.len=수천 바이트 이상
model uri=inmemory://model/N lineCount=N
```

그리고 host DOM이 `class="monaco-editor ... vs-dark"`로 꾸며지면 진짜 monaco widget이 자리 잡은 것.

## 브리틀 포인트 (VSCode 업데이트 시 깨질 가능성 있는 부분)

- Minified class 이름 (`ts`, `x`) — minifier가 바꾸면 우리가 찾는 방식은 영향 없음 (prototype chain 탐색). 참고용
- Duck-type 메서드 이름 (`layout`, `getModel`, `getDomNode`) — monaco editor API의 핵심이라 거의 안 바뀜
- `widgetOptions` 필드 (`isSimpleWidget`, `contributions`) — 상대적으로 안정. 새 필드가 required가 될 수는 있음
- `_instantiationService` 라는 private 필드 관례 — VSCode 내부 패턴 변화 시 바뀔 수 있음
- DI 패턴 자체가 Map/Array 기반 — 이건 거의 안 바뀔 영역

실제 VSCode 메이저 업데이트(e.g. 1.x → 2.x) 시점에만 손볼 필요. 마이너 업데이트는 대개 영향 없음.

## 전체 파이프라인 요약

```
Extension host
  └─ SIGUSR1 → Main process Node inspector (port 9229)
     └─ CDP WebSocket
        └─ Runtime.evaluate → main process context
           └─ BrowserWindow.getAllWindows().forEach()
              └─ webContents.debugger.attach('1.3')
                 └─ Runtime.evaluate(patchScript) in renderer
                    └─ Patch IIFE runs:
                        1. Hook Map/WeakMap/Set/Array.prototype
                        2. Hook Reflect.construct
                        3. Capture anything duck-type matching
                 └─ Runtime.addBinding('irSearchEvent')
                 └─ debugger.on('message') → forward binding calls
           └─ Extension: force-open file → captures fill
              └─ Extension: peek captures, filter real widgets
                 └─ Prototype-walk to real class
                    └─ createInstance(class, host, opts, widgetOpts)
                       └─ modelService.createModel(content, lang)
                          └─ editor.setModel(model)
                             └─ editor.layout({w, h})
                                → monaco widget rendered in our DOM
```

## 참고

이 패치 스크립트는 `IntelliJ Styled Search` VSCode 확장에서 사용됨. 파일:

- `src/rendererPatch.ts` — renderer-side IIFE 패치 (V40+)
- `src/overlayPanel.ts` — extension-side CDP 주입 및 진단 orchestrator
- `scripts/bundleMonaco.js` — (예비) 자체 monaco 번들링 대안 (사용 안 함)
