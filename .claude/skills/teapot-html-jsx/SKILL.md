---
name: teapot-html-jsx
description: 티팟(teapotchat.com) 캐릭터에 들어가는 HTML·마크다운(캐릭터 가이드라인, 시작 메시지, 상태창 템플릿 등)과 JSX 컴포넌트를 티팟 렌더링·보안 규칙에 맞게 작성하고 검토한다. 티팟 HTML, 가이드라인 디자인, 시작 메시지 꾸미기, 상태창, JSX 컴포넌트, teapot_* 도구로 이런 필드를 고칠 때 사용.
---

# 티팟 HTML · JSX 작성 규칙

티팟 프론트엔드 코드(2026-11 기준)를 분석해서 정리한 규칙이에요. 티팟이 업데이트되면 달라질 수 있어요.

## 0. 작업 수칙 (가장 먼저, 매번 지킬 것)
사용자가 티팟 제작창·편집기에서 직접 고치거나 다른 세션이 함께 작업할 수 있어요. 아래 두 가지를 지키지 않으면 작업 내용이 사라져요.

1. **반드시 서버 최신본을 확인한 뒤 작업해요.**
   - 고치기 직전에 `teapot_get`(또는 `teapot_pull`)으로 서버의 지금 내용을 다시 읽어요. 대화 앞부분에서 읽은 내용이나 예전에 만든 로컬 파일을 기준으로 삼지 마세요.
   - 로컬 파일(작업 폴더, `teapot_put_file`용 파일)이 있으면 서버 최신본과 비교해요. 서버 쪽이 더 새로우면 서버 내용을 로컬 파일에 먼저 반영한 다음 고쳐요.
   - `teapot_pull`은 폴더를 서버 내용으로 덮어써요. 아직 올리지 않은 로컬 수정이 있으면 pull 하기 전에 먼저 올리거나 따로 보관해요.
   - `teapot_push`가 "서버 저장본이 바뀌었다"며 거부하면 `force`로 밀어붙이지 말고, 다시 받아서 바뀐 부분을 합친 뒤 올려요.
2. **수정할 때 파일·칸을 통째로 다시 쓰지 말고, 고칠 부분만 고쳐요.**
   - 로컬 파일은 Write로 전체를 새로 쓰지 말고 Edit으로 바꿀 부분만 바꿔요. 새 파일을 만들 때만 전체를 써요.
   - `teapot_update`의 `patch`는 그 칸 전체를 바꿔요. 최신 내용을 읽은 다음 필요한 부분만 고친 전체 내용을 넣고, 관계없는 칸은 `patch`에 넣지 마세요.
   - 시작 상황은 `start_patches`로 바꿀 필드만 보내요.
   - `teapot_put_file`은 파일 내용으로 칸 전체를 바꿔요. 그 파일은 서버 최신본에서 출발해 고칠 부분만 고친 것이어야 해요. 저장 전 `dry_run: true`로 글자 수 변화를 보고, 예상보다 크게 줄었으면 저장하지 말고 원인을 확인해요.

## 1. HTML · 마크다운 렌더링 (가이드라인, 시작 메시지, 채팅 메시지)

티팟은 react-markdown으로 렌더링해요. 순서는 이래요.

1. **마크다운 파싱**: remark-gfm을 써요. 표, 취소선, 자동 링크, 체크리스트를 지원해요.
2. **HTML 허용**: rehype-raw로 마크다운 안에 섞인 HTML을 그대로 살려요.
3. **티팟 자체 정리 규칙**:
   - 태그 이름이 `^[a-zA-Z][a-zA-Z0-9-]*$` 형식이 아니면 `span`으로 바꿔요. `il`은 `li`로 고쳐요.
   - `on`으로 시작하는 속성(`onclick`, `onerror` 등)은 전부 지워요. **HTML에서는 이벤트·스크립트가 안 돌아가요.**
   - `href`/`src`가 `javascript:`, `vbscript:`, `data:text/html`로 시작하면 지워요.
   - 이 요소들은 **자식까지 통째로** 지워요: `html`, `head`, `script`, `iframe`, `object`, `embed`.
   - 그 밖의 태그는 허용돼요: `div`, `span`, `img`, `table`, `details`, `summary`, `svg`, `style`, `link` 등.
4. **`<style>` 처리**:
   - CSS 선택자 앞에 렌더링 컨테이너 범위가 붙어요.
   - `html`, `body`, `:root` 선택자는 컨테이너 자신으로 바뀌어요.
   - `@import`는 지워요. **웹폰트는 `<link rel="stylesheet" href="...">` 태그로 불러오세요.** `link`는 허용돼요.
   - `@media`, `@supports`는 안쪽 선택자에도 범위가 붙어요. `@keyframes`, `@font-face`는 그대로 두되 키프레임 이름 앞에 `tp-u-`가 붙어요(애니메이션 이름도 같이 바뀌니 신경 쓸 필요 없어요).
5. **태그별 기본 스타일** (Tailwind preflight 기반이라 브라우저 기본 여백이 0이에요):
   - `p`: 아래 여백 1em. 마지막 `p`는 0이에요. `p` 안에 `img`/`div`/`pre`/`blockquote`/`ul`/`ol`/`table`/`figure`/`details`/`hr`/`p`가 있으면 `div`로 바뀌어요.
   - `*기울임*`(em)은 **기울지 않고 색만 바뀌는 span**이에요.
     - 가이드라인: #374a64 (다크 모드 #ded682)
     - 채팅 라이트 테마: #727272 회색. 서술용으로 써요.
   - `**굵게**`: font-weight 700
   - `h1`: 20px bold, 위아래 여백 12px / `h2`: 18px bold, 8px / `h3`: 16px semibold, 8px
   - `ul`/`ol`: 마커가 안쪽(list-inside), 위아래 여백 8px
   - `blockquote`: 왼쪽 4px 회색 선, 기울임, #4b5563
   - `a`: 새 탭에서 열리고 파란색
   - `pre`: 둥근 박스, 줄바꿈 유지
   - `img`: `display:block; max-width:100%`
6. **컨테이너 스타일**:
   - 공통: Pretendard 15px, 굵기 500, 줄간격 1.75, 자간 -0.02em, `word-break:break-all`, 양쪽 정렬, 최대 폭 640px
   - **가이드라인**: 글자색 거의 검정. 하위 요소의 font-weight는 inherit이고 strong만 700이에요.
   - **채팅(시작 메시지)**: 컨테이너 글자색 #727272, 문단(`p`)과 굵게는 #000이에요.
   - 내 글씨체와 크기는 인라인 `style`로 직접 지정하세요. 인라인 스타일이 기본 스타일보다 우선해요.
7. **마크다운과 HTML을 섞을 때 주의**:
   - CommonMark 규칙상 HTML 블록은 **빈 줄이 나올 때까지** 이어져요. HTML 블록 바로 아래 줄에 쓴 `# 제목`이나 `*강조*`는 마크다운으로 처리되지 않아요. HTML과 마크다운 사이에는 빈 줄을 넣으세요.
   - HTML 블록 안에서 줄 앞에 4칸 이상 들여쓰기한 뒤 빈 줄이 나오면 코드 블록으로 바뀔 수 있어요. 깊은 들여쓰기는 피하세요.
8. **변수(시작 메시지)**:
   - `{user}`: 유저 페르소나 이름
   - `{char}`: 캐릭터 제목
   - `{{img::이름}}`: 상황 이미지 중 이름이 같은 이미지

### 길이 제한
- 시작 메시지: 3,000자
- 시작 상황 설명: 500자 (AI에게만 보임)
- 시작 상황 이름: 20자
- 캐릭터 소개(다인 채팅 등장인물): 30,000자
- 공용 프롬프트에 더하기: 칸마다 100,000자
- 로어북: 이름 60자, 정보 2,500자, 키워드 10개, 항목 최대 500개

## 2. JSX 컴포넌트 (AI가 채팅 중에 호출하는 사용자 정의 UI)

### 저장 전 보안 검증 (티팟 코드 그대로)
- 코드가 비어 있으면 안 돼요.
- `import`/`export` 문을 쓸 수 없어요. 줄 처음에 오는 것은 전부 막혀요.
  - React와 Hooks(`useState`, `useEffect` 등)는 **import 없이 바로** 써요.
- 컴포넌트는 반드시 **PascalCase 함수** 형식이어야 해요.
  - `function StatusBoard({ hp = 0 }) { ... }`
  - `const StatusBoard = ({ hp = 0 }) => { ... }`
- **금지 태그**(`<태그` 형태로만 들어가도 차단): `script`, `iframe`, `embed`, `object`, `link`, `meta`, `base`
  - JSX 안에서는 `<link>`로 폰트를 불러올 수 없어요. 필요하면 `<style>{"@font-face{...}"}</style>`를 쓰거나 기본 글꼴을 쓰세요.
- **금지 속성**: `dangerouslySetInnerHTML`, `srcDoc`, `srcdoc`, `formAction`, `formaction`
- **금지 패턴**:
  - `window.parent`, `window.top`, `window.opener`, `window.frames`
  - `parent.postMessage`
  - `eval(`
  - `new Function(`
- 위 검사는 **문자열 패턴 검사**예요. 주석이나 문자열 안에 들어 있어도 걸리니 쓰지 마세요.
- 허용되는 것: Hooks, `onClick` 같은 이벤트, `style={{ }}` 인라인 스타일

### 데이터 구조 (`jsx_components[]`, 시작 상황별로는 `additional_jsx_components[]`)
```json
{ "id": "uuid", "name": "StatusBoard", "display_name": "캐릭터 상태창",
  "description": "AI가 언제 이 컴포넌트를 부를지 (예: HP/MP 등 능력치를 표시할 때 호출)",
  "enabled": true, "is_creator": false,
  "trigger": "always" | "keyword", "keys": ["키워드"],
  "props": [{ "name": "hp", "type": "string", "description": "AI에게 전달할 설명", "example": "80", "required": false }],
  "code": "function StatusBoard({ hp = 0 }) { ... }",
  "compiled_ast": null, "compiled_hash": "<FNV-1a(code)>" }
```
- `name`은 코드의 함수 이름과 같아야 해요. props는 `{ }` 구조 분해로 선언하면 Props 정의와 연결돼요.
- `props[].description`과 `example`은 **AI에게 전달**돼요. AI가 값을 어떻게 채울지 구체적으로 쓰세요.
  - 배열이나 객체는 type을 `string`으로 두고, `messages={[...]}`처럼 표현식으로 출력하라고 설명에 적어요.
- `trigger`
  - `"always"`: 항상 프롬프트에 들어가요.
  - `"keyword"`: 유저 입력이나 직전 답변에 `keys` 중 하나가 나올 때만 들어가요(로어북처럼). 키워드는 최대 10개, 각 50자까지예요.
- `is_creator`: `false` = 사용자용, `true` = 제작자용
- 코드 최대 길이: 200,000자
- 시작 상황별 JSX +에서 같은 `name`을 쓰면 공용 JSX를 덮어써요.
- **코드를 바꾸면** `compiled_ast`를 `null`로 바꾸고 `compiled_hash`를 다시 계산해야 해요. 티팟 편집기와 같은 방식이에요.
  ```js
  function fnv1a(s){let t=0x811c9dc5;for(let n=0;n<s.length;n++)t^=s.charCodeAt(n),t=Math.imul(t,0x1000193);return(t>>>0).toString(16)}
  ```
  teapot-agent의 편집기와 `teapot_update`·`teapot_push`는 코드가 바뀐 JSX를 찾아서 이 처리를 **자동으로** 해요.
- 분량(프롬프트 글자 수)에는 **enabled인 JSX의 name, display_name, description, props(name, description, example)만** 들어가요. 코드는 들어가지 않아요.

## 3. 작업 순서 (teapot-agent 도구와 함께)
1. `teapot_overview`로 구조를 보고, `teapot_get`으로 필요한 필드만 읽어요. 예: `guidelines`, `start_settings`, `jsx_components`
   - 고치기 직전에는 꼭 다시 읽어서 서버 최신본을 기준으로 해요. (0. 작업 수칙)
2. 위 규칙에 맞게 고칠 부분만 고친 다음 `teapot_update`로 저장해요.
   - **긴 JSX 코드·HTML 가이드라인·시작 메시지는 로컬 파일로 작성한 뒤 `teapot_put_file`로 넣어요.** 서버가 파일을 직접 읽으므로 내용을 대화로 옮겨 적다 생기는 누락·오타가 없어요. 먼저 `dry_run: true`로 확인하고, JSX는 같은 폴더의 `<이름>.meta.json`으로 설명·props까지 맞출 수 있어요.
   - 심사 중이거나 등록 완료된 저장본(✓)은 덮어쓸 수 없어요. `save_as_new`를 쓰세요.
   - `prompt_char_count`는 건드리지 마세요. 티팟이 등록할 때 계산해요.
3. 사용자에게 로컬 편집기(http://127.0.0.1:18765/)에서 미리보기로 확인해 달라고 안내해요. 가이드라인과 시작 메시지는 티팟과 같은 규칙으로 렌더링되고, 요소를 클릭하면 해당 코드 줄로 이동해요.

## 4. 자주 하는 실수
- HTML에 `onclick`이나 `<script>`를 넣었는데 동작하지 않음 → 티팟이 지워요. 상호작용이 필요하면 JSX 컴포넌트를 쓰세요.
- `<style>`의 `body{...}`가 페이지 전체에 적용될 거라고 기대함 → 컨테이너에만 적용돼요.
- `@import`로 넣은 폰트가 안 나옴 → `<link rel="stylesheet">`로 바꾸세요.
- 시작 메시지에서 `*서술*`을 기울임으로 기대함 → 기울지 않고 회색으로만 나와요.
- JSX에서 `import React`를 씀 → 검증에서 실패해요.
