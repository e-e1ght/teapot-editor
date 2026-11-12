"use strict";
// 티팟 편집기: 왼쪽 폴더 트리에서 항목을 고르면 오른쪽에 그 항목 편집창 하나만 보인다.

// ---------------- 상태 ----------------
const S = {
  cid: null,
  cpid: null,
  checkpoint: null, // 서버에서 받은 저장본 (time_saved 등)
  original: null, // 받은 스냅샷 (비교용)
  working: null, // 편집 중 스냅샷
  current: null, // 선택된 항목 id
  jsonDrafts: new Map(), // json 입력칸 id -> {text, error}
  showCommon: true,
  filter: "",
  tabs: [],
  busy: false,
};

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("teapot-editor:" + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("teapot-editor:" + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------------- 허브 API ----------------
async function hub(type, payload = {}) {
  const r = await fetch("/api/request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" },
    body: JSON.stringify({ type, source: "editor", ...payload }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "요청 실패");
  return j.result;
}
const call = (fn, data) => hub("call", { fn, data });

// ---------------- 경로 유틸 ----------------
function getPath(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (o[path[i]] == null) o[path[i]] = typeof path[i + 1] === "number" ? [] : {};
    o = o[path[i]];
  }
  o[path[path.length - 1]] = value;
}

// 티팟이 JSX 코드 저장 시 쓰는 해시 (FNV-1a 32bit, 16진수)
function fnv1a(s) {
  let t = 0x811c9dc5;
  for (let n = 0; n < s.length; n++) (t ^= s.charCodeAt(n)), (t = Math.imul(t, 0x1000193));
  return (t >>> 0).toString(16);
}

// ---------------- 목록(리스트) 스키마 ----------------
// fields: 보여줄 순서와 이름. kind: line(한 줄) | text(긴 글) | tags(쉼표 구분 목록) | image | json
// 스키마에 없는 키는 값 모양을 보고 자동으로 칸을 만든다. hidden 키는 숨기되 보존한다.
const LIST_SCHEMAS = {
  keyword_books: {
    label: "로어북", titleKey: "title", empty: { title: "", keys: [], info: "" },
    fields: [
      { key: "title", label: "제목", kind: "line" },
      { key: "keys", label: "키워드 (쉼표로 구분)", kind: "tags" },
      { key: "info", label: "내용", kind: "text" },
    ],
    hidden: ["indexLabel"],
  },
  example_dialogues: {
    label: "예시대화", titleKey: "user", empty: { user: "", char: "" },
    fields: [
      { key: "user", label: "유저", kind: "text" },
      { key: "char", label: "캐릭터", kind: "text" },
    ],
  },
  commands: {
    label: "커맨드", titleKey: "name", empty: { name: "", description: "", body: "" },
    fields: [
      { key: "name", label: "이름", kind: "line" },
      { key: "description", label: "설명", kind: "line" },
      { key: "body", label: "내용", kind: "text" },
    ],
    hidden: ["id"],
  },
  personas: {
    label: "페르소나", titleKey: "name", empty: { name: "", memo: "", content: "" },
    fields: [
      { key: "name", label: "이름", kind: "line" },
      { key: "memo", label: "메모", kind: "line" },
      { key: "content", label: "내용", kind: "text" },
    ],
  },
  guidelines: {
    label: "캐릭터 가이드라인", titleKey: "title", empty: { title: "", content: "" },
    preview: "guide", previewKey: "content",
    fields: [
      { key: "title", label: "제목", kind: "line" },
      { key: "content", label: "내용 (마크다운 + HTML)", kind: "html" },
    ],
  },
  player_note: {
    label: "플레이어 노트", titleKey: "title", empty: { title: "", description: "", note: "" },
    fields: [
      { key: "title", label: "제목", kind: "line" },
      { key: "description", label: "설명", kind: "line" },
      { key: "note", label: "노트 내용", kind: "text" },
    ],
  },
  jsx_components: {
    label: "JSX", titleKey: "display_name", growKey: "code", preview: "jsx", previewKey: "code",
    empty: () => ({ id: crypto.randomUUID(), name: "", display_name: "", description: "", enabled: true, code: "", props: [], trigger: "always", keys: [], is_creator: false }),
    fields: [
      { key: "is_creator", label: "용도", kind: "select", options: [[false, "사용자용"], [true, "제작자용"]] },
      { key: "name", label: "이름 (코드의 함수 이름, 예: StatusBoard)", kind: "line" },
      { key: "display_name", label: "표시 이름", kind: "line" },
      { key: "description", label: "설명 (AI가 언제 이 JSX를 부를지)", kind: "text" },
      { key: "enabled", label: "사용 여부 (끄면 AI가 이 JSX를 쓰지 않아요)", kind: "check" },
      { key: "trigger", label: "상시 여부", kind: "select", options: [["always", "상시"], ["keyword", "키워드로 발동"]] },
      { key: "keys", label: "발동 키워드 (쉼표로 구분, 키워드 발동일 때)", kind: "tags" },
      { key: "props", label: "Props 정의", kind: "props" },
      { key: "code", label: "코드", kind: "code" },
    ],
    hidden: ["id", "compiled_ast", "compiled_hash"],
    hint: "티팟은 JSX를 저장하기 전에 보안 검증을 해요. 이 편집기는 그 검증을 못 하니, 코드를 크게 고쳤다면 티팟 JSX 편집기에서 한 번 열어 확인해 주세요.",
    // 티팟과 똑같이: 코드가 바뀌면 컴파일 캐시를 비우고 해시(FNV-1a)를 다시 계산
    afterSet(rec, key) {
      if (key === "code" && rec) {
        rec.compiled_ast = null;
        rec.compiled_hash = fnv1a(rec.code ?? "");
      }
    },
  },
  characters: {
    label: "다인 채팅 UI (등장인물)", titleKey: "name", max: 100,
    empty: () => ({ name: "", image: "", description: "", _sortKey: crypto.randomUUID() }),
    fields: [
      { key: "image", label: "이미지", kind: "image" },
      { key: "name", label: "캐릭터 이름", kind: "line" },
      { key: "description", label: "캐릭터 소개", kind: "text", limit: 30000 },
    ],
    hidden: ["_sortKey"],
    newIds: ["_sortKey"],
    hint: "다인 채팅에서 함께 등장할 캐릭터예요. 이미지 업로드는 티팟 UI 탭에서 해 주세요.",
  },
  circumstance_images: {
    label: "상황 이미지", titleKey: "name", noAdd: true,
    fields: [
      { key: "image", label: "이미지", kind: "image" },
      { key: "name", label: "이름", kind: "line" },
      { key: "circumstance", label: "상황 설명", kind: "line" },
    ],
    hidden: ["id", "publicImages"],
    hint: "이미지 파일 업로드·교체는 티팟 미디어 관리에서 해 주세요. 여기서는 이름과 상황 설명만 고칠 수 있어요.",
  },
  recommended_answers: { label: "추천 답변", empty: "" },
};
LIST_SCHEMAS.additional_keyword_books = { ...LIST_SCHEMAS.keyword_books, label: "로어북 +" };
LIST_SCHEMAS.additional_example_dialogues = { ...LIST_SCHEMAS.example_dialogues, label: "예시대화 +" };
LIST_SCHEMAS.additional_jsx_components = { ...LIST_SCHEMAS.jsx_components, label: "JSX +" };

// 시작 상황의 「공용 프롬프트에 더하기」 텍스트 칸
const ADD_TEXT = [
  ["additional_prompt", "prompt", "기본 정보"],
  ["additional_worldview", "worldview", "세계관"],
  ["additional_secret", "secret", "비밀"],
  ["additional_output_format", "output_format_prompt", "출력 형식"],
];
const SETTINGS_KEYS = [
  "model", "max_output_token", "recommended_llm", "prompt_mode", "template", "template_version",
  "genre", "target", "conv_type", "is_nsfw", "publicity", "comments_enabled",
];

// ---------------- 트리 정의 ----------------
function item(path, label, opts = {}) {
  return { id: path.join("."), path, label, kind: "text", ...opts };
}

function recordTitle(schema, v, i) {
  let t = typeof v === "string" ? v : (schema.titleKey && v?.[schema.titleKey]) || v?.name || v?.title;
  t = String(t ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > 40 ? t.slice(0, 40) + "…" : t) : `(${i + 1}번, 제목 없음)`;
}

function listFolder(snap, path, opts = {}) {
  const key = path[path.length - 1];
  const schema = LIST_SCHEMAS[key];
  const arr = getPath(snap, path) ?? [];
  return {
    id: "list:" + path.join("."),
    label: opts.label ?? schema.label,
    list: { path, schema },
    items: arr.map((v, i) =>
      item([...path, i], recordTitle(schema, v, i), { kind: "record", schema, listPath: path, index: i })
    ),
  };
}

function buildTree(snap) {
  const starts = snap.start_settings ?? [];
  const snippets = Object.keys(snap.prompt_template_overrides?.snippet_overrides ?? {});
  return [
    {
      id: "info", label: "캐릭터 정보",
      items: [
        {
          id: "__info", label: "제목 · 소개 · 태그", kind: "info",
          get: (s) => ({ char_name: s.char_name, oneline_description: s.oneline_description, detail_description: s.detail_description, hash_tags: s.hash_tags }),
          set: () => {},
        },
      ],
      children: [listFolder(snap, ["guidelines"])],
    },
    {
      id: "common", label: "공용 프롬프트",
      items: [
        item(["prompt"], "기본 정보"),
        item(["worldview"], "세계관"),
        item(["secret"], "비밀"),
        item(["output_format_prompt"], "출력 형식"),
        item(["recommended_answer_prompt"], "추천 답변 프롬프트", { limit: 1000 }),
      ],
      children: [
        listFolder(snap, ["example_dialogues"]),
        listFolder(snap, ["keyword_books"]),
        listFolder(snap, ["jsx_components"]),
        {
          id: "ui", label: "UI",
          items: [{ id: "__status", label: "상태창 UI", kind: "status", get: (s) => s.simulation_status, set: () => {} }],
          children: [listFolder(snap, ["characters"])],
        },
        ...(snippets.length
          ? [{
              id: "snippets", label: "템플릿 문구 (수정한 것)",
              items: snippets.map((k) =>
                item(["prompt_template_overrides", "snippet_overrides", k, "content_template"], k, {
                  hint: "티팟 프롬프트 템플릿에서 직접 고친 문구예요. 고치지 않은 기본 문구는 여기 안 보여요.",
                })
              ),
            }]
          : []),
      ],
    },
    {
      id: "starts", label: "시작 상황", kind: "starts",
      children: starts.map((s, i) => ({
        id: `start-${i}`, label: s.setting_name || `시작 상황 ${i + 1}`, startIndex: i,
        items: [
          {
            id: `start_settings.${i}.__main`, label: "이름 · 상황 · 시작 메시지", kind: "start", startIndex: i,
            get: (s) => {
              const x = s.start_settings?.[i] ?? {};
              return { setting_name: x.setting_name, start_circumstance: x.start_circumstance, start_message: x.start_message };
            },
            set: () => {},
          },
        ],
        children: [
          listFolder(snap, ["start_settings", i, "recommended_answers"]),
          {
            id: `start-${i}-add`, label: "공용 프롬프트에 더하기",
            items: ADD_TEXT.map(([f, common, name]) =>
              item(["start_settings", i, f], `${name} +`, {
                common, commonLabel: name,
                hint: `이 시작 상황에서만 공용 「${name}」 뒤에 더해지는 내용이에요.`,
              })
            ),
            children: [
              listFolder(snap, ["start_settings", i, "additional_example_dialogues"]),
              listFolder(snap, ["start_settings", i, "additional_keyword_books"]),
              listFolder(snap, ["start_settings", i, "additional_jsx_components"]),
            ],
          },
        ],
      })),
    },
    {
      id: "extra", label: "기타",
      children: [
        listFolder(snap, ["player_note"]),
        listFolder(snap, ["personas"]),
        listFolder(snap, ["commands"]),
      ],
      items: [
        { id: "__images", label: "상황 이미지", kind: "images", get: (s) => s.circumstance_images, set: () => {} },
      ],
    },
    {
      id: "settings", label: "설정",
      items: [
        {
          id: "__settings", label: "모델 · 공개 설정", kind: "settings",
          get: (s) => Object.fromEntries(SETTINGS_KEYS.filter((k) => k in s).map((k) => [k, s[k]])),
          set: (s, v) => Object.assign(s, v),
          hint: "모델, 최대 출력 토큰, 장르, 대상, 공개 여부 등 (JSON)",
        },
        item(["prompt_template_overrides", "section_order_override"], "프롬프트 섹션 순서", { kind: "json" }),
      ],
    },
  ];
}

const itemGet = (it, snap) => (it.get ? it.get(snap) : getPath(snap, it.path));
const itemSet = (it, snap, v) => (it.set ? it.set(snap, v) : setPath(snap, it.path, v));
const draftError = (id) => [...S.jsonDrafts.entries()].some(([k, d]) => d.error && (k === id || k.startsWith(id + "#")));
function isDirty(it) {
  if (!it) return false;
  if (draftError(it.id)) return true;
  return !same(itemGet(it, S.working), itemGet(it, S.original));
}

let ITEMS = new Map(); // id -> item
let FOLDERS = new Map(); // id -> folder
function indexTree(tree) {
  ITEMS = new Map();
  FOLDERS = new Map();
  const walk = (nodes, crumbs) => {
    for (const n of nodes) {
      FOLDERS.set(n.id, n);
      for (const it of n.items ?? []) ITEMS.set(it.id, { ...it, crumbs: [...crumbs, n.label] });
      walk(n.children ?? [], [...crumbs, n.label]);
    }
  };
  walk(tree, []);
}

// ---------------- 트리 렌더 ----------------
const closed = new Set(store.get("closed", ["extra", "settings"]));

function sizeOf(v) {
  if (typeof v === "string") return v.length ? v.length.toLocaleString() : "";
  if (Array.isArray(v)) return v.length ? `${v.length}` : "";
  if (v && typeof v === "object") {
    const n = Object.values(v).reduce((a, x) => a + (typeof x === "string" ? x.length : 0), 0);
    return n ? n.toLocaleString() : "";
  }
  return "";
}

function matchesFilter(it) {
  const q = S.filter;
  if (!q) return true;
  if (it.label.toLowerCase().includes(q)) return true;
  const v = itemGet(it, S.working);
  return JSON.stringify(v ?? "").toLowerCase().includes(q);
}

function renderTree() {
  const tree = buildTree(S.working);
  indexTree(tree);
  const nodes = tree.map((n) => renderFolder(n)).filter(Boolean);
  $("#tree").replaceChildren(...nodes);
  if (!nodes.length) $("#tree").append(el("div", { class: "tree-empty" }, "찾는 내용이 없어요."));
  updateTitleDirty();
}

function folderDirty(n) {
  if (n.list && !same(getPath(S.working, n.list.path), getPath(S.original, n.list.path))) return true;
  return (n.items ?? []).some((it) => isDirty(ITEMS.get(it.id))) || (n.children ?? []).some(folderDirty);
}

// GitHub Octicons (16px)
const ICONS = {
  chevron: "M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z",
  folder: "M0 2.75C0 1.784.784 1 1.75 1H5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1h6.75c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Z",
  folderOpen: "M.513 1.513A1.75 1.75 0 0 1 1.75 1h3.5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1H13a1 1 0 0 1 1 1v.5H2.75a.75.75 0 0 0 0 1.5h11.978a1 1 0 0 1 .994 1.117L15 13.25A1.75 1.75 0 0 1 13.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75c0-.464.184-.91.513-1.237Z",
  file: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z",
};
function icon(name, cls) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", ICONS[name]);
  svg.append(p);
  return svg;
}

function act(label, title, fn) {
  return el("button", { title, onclick: (e) => (e.stopPropagation(), fn()) }, label);
}

function renderFolder(n) {
  const items = (n.items ?? []).map((it) => ITEMS.get(it.id)).filter(matchesFilter).map(renderItem);
  const kids = (n.children ?? []).map(renderFolder).filter(Boolean);
  if (S.filter && !items.length && !kids.length && !n.label.toLowerCase().includes(S.filter)) return null;

  const actions = [];
  if (n.kind === "starts") actions.push(act("+ 추가", "새 시작 상황", addStart));
  if (n.startIndex != null) {
    actions.push(act("복제", "시작 상황 복제", () => duplicateStart(n.startIndex)));
    actions.push(act("삭제", "시작 상황 삭제", () => removeStart(n.startIndex)));
  }
  if (n.list && !n.list.schema.noAdd) actions.push(act("+ 추가", `${n.list.schema.label} 항목 추가`, () => addRecord(n.list.path)));

  const isClosed = !S.filter && closed.has(n.id);
  const count = n.list ? el("span", { class: "meta" }, String(n.items.length || "")) : null;
  const row = el(
    "div",
    { class: "row", onclick: () => toggleFolder(n.id) },
    icon("chevron", "caret"),
    icon("folder", "ico ico-folder"),
    icon("folderOpen", "ico ico-folder-open"),
    el("span", { class: "label", title: n.label }, n.label),
    folderDirty(n) ? el("span", { class: "dot", title: "변경됨" }) : null,
    actions.length ? el("span", { class: "actions" }, actions) : null,
    count
  );
  return el(
    "div",
    { class: "folder" + (isClosed ? " closed" : "") + (n.list ? " list" : ""), "data-id": n.id },
    row,
    el("div", { class: "children" }, items, kids)
  );
}

function renderItem(it) {
  const v = itemGet(it, S.working);
  const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
  const actions =
    it.kind === "record"
      ? el(
          "span",
          { class: "actions" },
          act("↑", "위로", () => moveRecord(it, -1)),
          act("↓", "아래로", () => moveRecord(it, 1)),
          it.schema.noAdd ? null : act("복제", "복제", () => duplicateRecord(it)),
          act("삭제", "삭제", () => removeRecord(it))
        )
      : null;
  return el(
    "div",
    {
      class: "item row" + (S.current === it.id ? " selected" : "") + (empty ? " empty-val" : ""),
      "data-id": it.id,
      onclick: () => select(it.id),
      title: it.label,
    },
    icon("file", "ico ico-file"),
    el("span", { class: "label" }, it.label),
    isDirty(it) ? el("span", { class: "dot", title: "변경됨" }) : null,
    actions,
    el("span", { class: "meta" }, it.get ? "" : sizeOf(v))
  );
}

function toggleFolder(id) {
  if (S.filter) return;
  closed.has(id) ? closed.delete(id) : closed.add(id);
  store.set("closed", [...closed]);
  document.querySelector(`.folder[data-id="${CSS.escape(id)}"]`)?.classList.toggle("closed");
}

// 편집 중에는 트리 전체를 다시 그리지 않고 해당 항목과 상위 폴더 표시만 갱신
function refreshTreeItem(id) {
  const it = ITEMS.get(id);
  const node = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (it && node) {
    if (it.kind === "record") it.label = recordTitle(it.schema, itemGet(it, S.working), it.index);
    node.replaceWith(renderItem(it));
  }
  S.onEdit?.();
  // 폴더 표시·제목·분량 막대는 타이핑이 잠깐 멈췄을 때 한 번에 갱신
  clearTimeout(S.marksTimer);
  S.marksTimer = setTimeout(refreshMarks, 200);
}

function refreshMarks() {
  for (const f of document.querySelectorAll(".folder")) {
    const n = FOLDERS.get(f.dataset.id);
    const row = f.firstElementChild;
    const dirty = n ? folderDirty(n) : false;
    const dot = row.querySelector(":scope > .dot");
    if (dirty && !dot) row.querySelector(".label").after(el("span", { class: "dot", title: "변경됨" }));
    if (!dirty && dot) dot.remove();
  }
  updateTitleDirty();
  updateMeter();
}

function anyDirty() {
  if (!S.working) return false;
  if ([...S.jsonDrafts.values()].some((d) => d.error)) return true;
  return !same(S.working, S.original);
}

function updateTitleDirty() {
  const d = anyDirty();
  document.title = (d ? "● " : "") + "티팟 편집기" + (S.working?.char_name ? ` — ${S.working.char_name}` : "");
  $("#btnSave").disabled = !d || S.busy;
}

// ---------------- 편집 패널 ----------------
function select(id) {
  S.current = id;
  store.set("current", id);
  document.querySelectorAll(".item.selected").forEach((n) => n.classList.remove("selected"));
  document.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.classList.add("selected");
  renderPane();
}

function counter(limit) {
  const c = el("span", { class: "count" });
  c.update = (v) => {
    const len = typeof v === "string" ? v.length : null;
    c.textContent = len == null ? "" : limit ? `${len.toLocaleString()} / ${limit.toLocaleString()}자` : `${len.toLocaleString()}자`;
    c.classList.toggle("over", !!(limit && len > limit));
  };
  return c;
}

// CodeMirror 편집기 (현재 화면에 있는 것들. 화면을 바꿀 때 정리한다)
S.editors = [];
function destroyEditors() {
  for (const e of S.editors) e.destroy();
  S.editors = [];
}
const LANG_OF = { text: "markdown", html: "markdown", code: "js", json: "plain" };

function cmHost({ doc, lang, onChange, fill, readOnly = false, gutter = true }) {
  const host = el("div", { class: "cm-host" + (fill ? " fill" : "") + (lang === "js" || lang === "plain" ? " mono" : "") });
  const crlf = String(doc ?? "").includes("\r\n");
  const ed = TPV.createEditor({ parent: host, doc: doc ?? "", lang, readOnly, onChange, gutter, wrap: lang !== "js", crlf });
  S.editors.push(ed);
  host.editor = ed;
  host.focus = () => ed.focus();
  return host;
}

// 한 칸짜리 입력기. get/set으로 값에 연결된다.
function fieldInput({ id, kind, get, set, onChange, limit, options, fill = false }) {
  const err = el("div", { class: "err hidden" });
  const count = counter(limit);
  let input;
  if (kind === "line") {
    input = el("input", { class: "line", type: "text", spellcheck: "false" });
    input.value = get() ?? "";
    input.addEventListener("input", () => (set(input.value), count.update(input.value), onChange()));
    count.update(input.value);
  } else if (kind === "tags") {
    input = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "예: 학교, 도서관" });
    input.value = (get() ?? []).join(", ");
    input.addEventListener("input", () => {
      set(input.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
      onChange();
    });
  } else if (kind === "json") {
    const draft = S.jsonDrafts.get(id);
    const showErr = (m) => ((err.textContent = "JSON 형식 오류: " + m), err.classList.remove("hidden"));
    input = cmHost({
      doc: draft ? draft.text : JSON.stringify(get() ?? null, null, 2), lang: "plain", fill,
      onChange: (text) => {
        try {
          set(JSON.parse(text));
          S.jsonDrafts.delete(id);
          err.classList.add("hidden");
        } catch (e) {
          S.jsonDrafts.set(id, { text, error: e.message });
          showErr(e.message);
        }
        onChange();
      },
    });
    if (draft?.error) showErr(draft.error);
  } else if (kind === "check") {
    input = el("input", { type: "checkbox", class: "check" });
    input.checked = !!get();
    input.addEventListener("change", () => (set(input.checked), onChange()));
  } else if (kind === "select") {
    const opts = [...(options ?? [])];
    const cur = get();
    if (cur !== undefined && !opts.some(([v]) => v === cur)) opts.push([cur, String(cur)]);
    input = el("select", { class: "sel" }, opts.map(([v, label], i) => el("option", { value: String(i) }, label)));
    input.value = String(Math.max(0, opts.findIndex(([v]) => v === cur)));
    input.addEventListener("change", () => (set(opts[Number(input.value)][0]), onChange()));
  } else {
    // text(마크다운) / html / code(JS) → CodeMirror. 줄바꿈 모양(\r\n)은 CodeMirror가 그대로 유지한다
    input = cmHost({
      doc: get() ?? "", lang: LANG_OF[kind] ?? "markdown", fill,
      onChange: (text) => (set(text), count.update(text), onChange()),
    });
    count.update(get() ?? "");
  }
  return { input, err, count };
}

function paneHead(it, extra = []) {
  return el(
    "div",
    { class: "pane-head" },
    el("div", { class: "head-text" }, el("div", { class: "crumb" }, it.crumbs.join(" › ")), el("div", { class: "title" }, it.label)),
    el("div", { class: "spacer" }),
    extra,
    el("button", { class: "small ghost", title: "이 항목을 불러온 상태로 되돌리기", onclick: () => revertItem(it) }, "되돌리기")
  );
}

function renderPane() {
  const pane = $("#pane");
  destroyEditors();
  S.onEdit = null;
  const it = ITEMS.get(S.current);
  if (!it || !S.working) {
    pane.replaceChildren(el("div", { class: "empty" }, S.working ? "왼쪽에서 항목을 고르세요." : "불러오는 중…"));
    return;
  }
  if (it.kind === "record") return renderRecordPane(it);
  if (it.kind === "status") return renderStatusPane(it);
  if (it.kind === "info") return renderInfoPane(it);
  if (it.kind === "images") return renderImagesPane(it);
  if (it.kind === "start") return renderStartPane(it);
  if (it.kind === "settings") return renderSettingsPane(it);

  const changed = () => refreshTreeItem(it.id);
  const f = fieldInput({
    id: it.id, kind: it.kind, limit: it.limit, fill: true,
    get: () => itemGet(it, S.working), set: (v) => itemSet(it, S.working, v), onChange: changed,
  });

  const extras = [f.count];
  if (it.common) {
    extras.push(
      el(
        "button",
        { class: "small ghost", onclick: () => ((S.showCommon = !S.showCommon), store.set("showCommon", S.showCommon), renderPane()) },
        S.showCommon ? "공용 내용 숨기기" : "공용 내용 같이 보기"
      )
    );
  }
  const editorCol = el(
    "div",
    { class: "editor-col" },
    it.common ? el("div", { class: "col-head" }, "이 시작 상황에서 더하는 내용") : null,
    it.kind === "line" || it.kind === "tags" ? el("div", { class: "line-wrap" }, f.input) : f.input,
    f.err
  );
  const cols = [editorCol];
  if (it.common && S.showCommon) {
    const ro = cmHost({ doc: S.working[it.common] ?? "", lang: "markdown", fill: true, readOnly: true });
    cols.unshift(
      el("div", { class: "editor-col" }, el("div", { class: "col-head" }, `공용 「${it.commonLabel}」 (읽기 전용 — 공용 프롬프트 › ${it.commonLabel}에서 수정)`), ro)
    );
  }
  pane.replaceChildren(paneHead(it, extras), it.hint ? el("div", { class: "hint" }, it.hint) : "", el("div", { class: "editor-wrap" }, cols));
  f.input.focus({ preventScroll: true });
}

function recordFields(schema, rec) {
  if (typeof rec === "string") return null;
  const shown = new Set([...(schema.fields ?? []).map((f) => f.key), ...(schema.hidden ?? [])]);
  const auto = Object.keys(rec ?? {})
    .filter((k) => !shown.has(k))
    .map((k) => {
      const v = rec[k];
      const kind =
        typeof v === "string" ? (v.length > 60 || v.includes("\n") ? "text" : "line")
        : Array.isArray(v) && v.every((x) => typeof x === "string") ? "tags"
        : "json";
      return { key: k, label: k, kind };
    });
  return [...(schema.fields ?? []), ...auto];
}

function renderRecordPane(it) {
  const pane = $("#pane");
  const rec = itemGet(it, S.working);
  const changed = () => refreshTreeItem(it.id);

  // 문자열 하나짜리 목록 (추천 답변 등)
  if (typeof rec === "string" || rec == null) {
    const f = fieldInput({
      id: it.id, kind: "text", fill: true,
      get: () => itemGet(it, S.working), set: (v) => itemSet(it, S.working, v), onChange: changed,
    });
    pane.replaceChildren(paneHead(it, [f.count]), el("div", { class: "editor-wrap" }, el("div", { class: "editor-col" }, f.input)));
    return f.input.focus({ preventScroll: true });
  }

  const fields = recordFields(it.schema, rec);
  const isBig = (f) => f.kind === "text" || f.kind === "json" || f.kind === "code" || f.kind === "html";
  const texts = fields.filter(isBig);
  // 긴 글 칸이 하나뿐이면 그 칸이 남은 공간을 다 쓴다
  const growField = texts.length === 1 ? texts[0] : null;
  const form = el("div", { class: "form" + (growField ? " single" : "") });
  let first;
  for (const fd of fields) {
    const get = () => getPath(S.working, [...it.path, fd.key]);
    const set = (v) => {
      setPath(S.working, [...it.path, fd.key], v);
      it.schema.afterSet?.(getPath(S.working, it.path), fd.key);
    };
    if (fd.kind === "image") {
      const url = get();
      form.append(
        el("div", { class: "field" }, el("label", {}, fd.label), url ? el("img", { class: "thumb", src: url, alt: "", loading: "lazy" }) : el("div", { class: "muted" }, "이미지 없음"))
      );
      continue;
    }
    if (fd.kind === "props") {
      form.append(propsEditor(it, fd, get, set, changed));
      continue;
    }
    const grow = growField === fd;
    const f = fieldInput({ id: `${it.id}#${fd.key}`, kind: fd.kind, get, set, onChange: changed, fill: grow, limit: fd.limit, options: fd.options });
    if (fd.kind !== "check" && fd.kind !== "select") first ??= f.input;
    const inline = fd.kind === "check" || fd.kind === "select";
    form.append(
      el(
        "div",
        { class: "field" + (grow ? " grow" : "") + (isBig(fd) ? " big" : "") + (fd.kind === "code" ? " code" : "") + (inline ? " inline" : ""), "data-key": fd.key },
        el("label", {}, fd.label, " ", f.count),
        f.input,
        f.err
      )
    );
  }
  const hiddenInfo = (it.schema.hidden ?? []).filter((k) => rec[k] != null && typeof rec[k] !== "object").map((k) => `${k}: ${rec[k]}`);
  const hint = it.schema.hint || hiddenInfo.length ? el("div", { class: "hint" }, [it.schema.hint, hiddenInfo.join(" · ")].filter(Boolean).join("  ·  ")) : "";
  // 미리보기가 있는 목록(캐릭터 가이드라인): 왼쪽 편집, 오른쪽 티팟 렌더링
  if (it.schema.preview) {
    const key = it.schema.previewKey;
    const edHost = form.querySelector(`.field[data-key="${key}"] .cm-host`);
    const pv =
      it.schema.preview === "jsx"
        ? makeJsxPreview({ record: () => getPath(S.working, it.path) ?? {}, editor: () => edHost?.editor })
        : makePreview({
            variant: it.schema.preview,
            source: () => getPath(S.working, [...it.path, key]) ?? "",
            editor: () => edHost?.editor,
          });
    S.onEdit = () => pv.update();
    pane.replaceChildren(paneHead(it, [pv.toggle]), hint, splitView(form, pv.el));
  } else {
    S.onEdit = null;
    pane.replaceChildren(paneHead(it), hint, form);
  }
  first?.focus({ preventScroll: true });
}

// JSX props 목록: 이름 / 타입 / 필수 / 예시값 / 설명
const PROP_TYPES = ["string", "number", "boolean", "array", "object"];
function propsEditor(it, fd, get, set, changed) {
  const box = el("div", { class: "field props" });
  const draw = () => {
    const props = get() ?? [];
    const update = (i, k, v) => {
      const next = clone(get() ?? []);
      next[i] = { ...next[i], [k]: v };
      set(next);
      changed();
    };
    const rows = props.map((p, i) => {
      const types = PROP_TYPES.includes(p.type) ? PROP_TYPES : [...PROP_TYPES, p.type];
      const name = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "이름 (camelCase)" });
      name.value = p.name ?? "";
      name.addEventListener("input", () => update(i, "name", name.value));
      const type = el("select", { class: "sel" }, types.map((t) => el("option", { value: t }, t)));
      type.value = p.type ?? "string";
      type.addEventListener("change", () => update(i, "type", type.value));
      const req = el("input", { type: "checkbox", class: "check" });
      req.checked = !!p.required;
      req.addEventListener("change", () => update(i, "required", req.checked));
      const ex = el("textarea", { class: "ed small-ed mono", spellcheck: "false", placeholder: "예시값 (AI 전달)" });
      ex.value = p.example ?? "";
      ex.addEventListener("input", () => update(i, "example", ex.value));
      const desc = el("textarea", { class: "ed small-ed", spellcheck: "false", placeholder: "설명 (AI 전달)" });
      desc.value = p.description ?? "";
      desc.addEventListener("input", () => update(i, "description", desc.value));
      const del = el("button", {
        class: "small ghost danger",
        onclick: () => {
          const next = clone(get() ?? []);
          next.splice(i, 1);
          set(next);
          changed();
          draw();
        },
      }, "삭제");
      return el(
        "div",
        { class: "prop" },
        el("div", { class: "prop-top" }, name, type, el("label", { class: "req" }, req, " 필수"), del),
        el("div", { class: "prop-sub" }, el("span", {}, "예시값"), ex),
        el("div", { class: "prop-sub" }, el("span", {}, "설명"), desc)
      );
    });
    const add = el("button", {
      class: "small",
      onclick: () => {
        set([...(get() ?? []), { name: "", type: "string", description: "", example: "", required: false }]);
        changed();
        draw();
      },
    }, "+ prop 추가");
    box.replaceChildren(el("label", {}, `${fd.label} (${props.length})`), ...(props.length ? rows : [el("div", { class: "muted" }, "아직 props가 없어요.")]), el("div", { class: "prop-add" }, add));
  };
  draw();
  return box;
}

// 상태창 UI (simulation_status): 끄면 필드 자체가 없어진다 (티팟과 동일)
function renderStatusPane(it) {
  const pane = $("#pane");
  const on = S.working.simulation_status != null;
  const toggle = el("input", { type: "checkbox", class: "check" });
  toggle.checked = on;
  toggle.addEventListener("change", () => {
    if (toggle.checked) S.working.simulation_status = clone(S.stashedStatus ?? S.original.simulation_status ?? { status_description: "", status_variable_constraint: "" });
    else {
      S.stashedStatus = clone(S.working.simulation_status);
      delete S.working.simulation_status;
    }
    refreshTreeItem(it.id);
    renderPane();
  });
  const head = paneHead(it, [el("label", { class: "opt big-opt" }, toggle, " 상태창 사용")]);
  if (!on) {
    pane.replaceChildren(head, el("div", { class: "empty" }, "상태창 UI가 꺼져 있어요. 오른쪽 위에서 켜면 템플릿과 변수 제어 프롬프트를 쓸 수 있어요."));
    return;
  }
  const form = el("div", { class: "form" });
  for (const [key, label, mono] of [
    ["status_description", "상태창 템플릿 (HTML 가능)", true],
    ["status_variable_constraint", "상태창 변수 제어 프롬프트", false],
  ]) {
    const f = fieldInput({
      id: `${it.id}#${key}`, kind: mono ? "code" : "text",
      get: () => S.working.simulation_status?.[key], set: (v) => (S.working.simulation_status[key] = v), onChange: () => refreshTreeItem(it.id),
    });
    form.append(el("div", { class: "field big" + (mono ? " code" : "") }, el("label", {}, label, " ", f.count), f.input));
  }
  pane.replaceChildren(head, el("div", { class: "hint" }, "상태창의 템플릿과 내용을 설정해요. 미리보기는 티팟 UI 탭에서 볼 수 있어요."), form);
}

// ---------------- 합친 화면들 ----------------
function formField(label, input, opts = {}) {
  return el(
    "div",
    { class: "field" + (opts.big ? " big" : "") + (opts.grow ? " grow" : "") + (opts.cls ? " " + opts.cls : ""), "data-key": opts.key },
    el("label", {}, label, opts.count ? [" ", opts.count] : null, opts.note ? el("span", { class: "note" }, opts.note) : null),
    input,
    opts.err
  );
}

// 캐릭터 정보: 제목·한 줄 소개·해시태그·상세 설명을 한 화면에
function renderInfoPane(it) {
  const s = S.working;
  const changed = () => refreshTreeItem(it.id);
  const form = el("div", { class: "form" });
  if (s.image) form.append(formField("프로필 이미지 (교체는 티팟에서)", el("img", { class: "thumb", src: s.image, alt: "" })));
  const fields = [
    ["char_name", "제목", "line", 30, "본문의 {char}는 이 제목으로 바뀌어요"],
    ["oneline_description", "한 줄 소개", "line", 35],
    ["hash_tags", "해시태그 (쉼표로 구분)", "tags"],
  ];
  let first;
  for (const [key, label, kind, limit, note] of fields) {
    const f = fieldInput({ id: `${it.id}#${key}`, kind, limit, get: () => s[key], set: (v) => (s[key] = v), onChange: changed });
    first ??= f.input;
    form.append(formField(label, f.input, { count: f.count, note, key }));
  }
  const d = fieldInput({ id: `${it.id}#detail_description`, kind: "text", get: () => s.detail_description, set: (v) => (s.detail_description = v), onChange: changed });
  form.append(formField("상세 설명", d.input, { count: d.count, big: true, key: "detail_description" }));
  $("#pane").replaceChildren(paneHead(it), form);
  first?.focus();
}

// 모델 · 공개 설정: 티팟 등록 화면의 선택지로 입력한다 (값의 형식은 티팟 저장 형식 그대로)
// 모델 목록은 2026-11 티팟 기준이다. 목록에 없는 모델도 직접 입력할 수 있다.
const TP_MODELS = {
  Max: ["claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "gemini-4-argon", "gemini-4-carbon", "muse-wonder", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.5", "gpt-5.6-sol"],
  Pro: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash", "deepseek-v4-pro", "glm-5.3", "glm-5.2", "glm-5.1", "gpt-5.4", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-luna", "kimi-k3"],
  Flash: ["gemini-3-flash-preview", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "deepseek-v4-flash", "deepseek-v3.2"],
};
const TP_GENRES = ["1:1 롤플레이", "다인 롤플레이", "시뮬레이션", "로맨스", "판타지", "현대", "무협", "BL", "역사", "일상"];
const TP_TARGETS = ["남성향", "여성향", "전체"];
const TP_PUBLICITY = [["0", "비공개"], ["1", "전체공개"], ["3", "링크공개"], ["2", "시리즈 전환 공개"]];

function renderSettingsPane(it) {
  const s = S.working;
  const changed = () => refreshTreeItem(it.id);
  const form = el("div", { class: "form settings-form" });
  const row = (label, input, note) => form.append(el("div", { class: "field" }, el("label", {}, label, note ? el("span", { class: "note" }, note) : null), el("div", { class: "set-row" }, input)));
  const select = (key, opts, { asNumber = false } = {}) => {
    const cur = s[key];
    const list = [...opts];
    if (cur != null && cur !== "" && !list.some(([v]) => String(v) === String(cur))) list.push([String(cur), `${cur} (현재 값)`]);
    const sel = el("select", { class: "sel" }, (cur == null || cur === "") ? el("option", { value: "" }, "선택 안 함") : null, list.map(([v, l]) => el("option", { value: v }, l)));
    sel.value = cur == null ? "" : String(cur);
    sel.addEventListener("change", () => ((s[key] = asNumber ? Number(sel.value) : sel.value), changed()));
    return sel;
  };
  const check = (key, text) => {
    const c = el("input", { type: "checkbox" });
    c.checked = !!s[key];
    c.addEventListener("change", () => ((s[key] = c.checked), changed()));
    return el("label", { class: "set-check" }, c, text);
  };

  // 모델: 목록에서 고르거나 직접 입력
  const model = el("input", { class: "line", type: "text", list: "tpModels", spellcheck: "false", placeholder: "예: gemini-3.8-flash" });
  model.value = s.model ?? "";
  model.addEventListener("input", () => ((s.model = model.value.trim()), changed()));
  const dl = el("datalist", { id: "tpModels" }, Object.entries(TP_MODELS).flatMap(([g, ms]) => ms.map((m) => el("option", { value: m, label: g }))));
  row("모델", el("div", { class: "set-grow" }, model, dl), "목록에서 고르거나 직접 입력");

  const tok = el("input", { class: "line num", type: "number", step: "1" });
  tok.value = s.max_output_token ?? "";
  tok.addEventListener("input", () => ((s.max_output_token = tok.value === "" ? null : Number(tok.value)), changed()));
  row("최대 출력 토큰", tok);

  row("프롬프트 모드", select("prompt_mode", [["simple", "간단 (simple)"], ["detail", "상세 (detail)"]]), "티팟 제작창의 프롬프트 입력 방식");

  // 장르: 눌러서 켜고 끄기 + 직접 추가
  const genres = () => (Array.isArray(s.genre) ? s.genre : []);
  const chips = el("div", { class: "set-chips" });
  const drawChips = () => {
    const all = [...new Set([...TP_GENRES, ...genres()])];
    chips.replaceChildren(
      ...all.map((g) => {
        const on = genres().includes(g);
        const b = el("button", { class: "chip" + (on ? " on" : ""), type: "button", "aria-pressed": on ? "true" : "false" }, g);
        b.addEventListener("click", () => {
          s.genre = on ? genres().filter((x) => x !== g) : [...genres(), g];
          changed();
          drawChips();
        });
        return b;
      })
    );
    const add = el("input", { class: "chip-add", type: "text", placeholder: "+ 직접 추가 (Enter)" });
    add.addEventListener("keydown", (e) => {
      const v = add.value.trim();
      if (e.key !== "Enter" || !v) return;
      e.preventDefault();
      if (!genres().includes(v)) s.genre = [...genres(), v];
      changed();
      drawChips();
      chips.querySelector(".chip-add")?.focus();
    });
    chips.append(add);
  };
  drawChips();
  row("장르", chips, "누르면 선택/해제");

  row("대상", select("target", TP_TARGETS.map((t) => [t, t])));
  row("공개 설정", select("publicity", TP_PUBLICITY));
  form.append(el("div", { class: "field" }, el("label", {}, "옵션"), el("div", { class: "set-row" }, check("is_nsfw", "성인(NSFW) 캐릭터"), check("comments_enabled", "댓글 허용"))));

  // 보통 바꿀 일이 없는 값들
  const adv = el("details", { class: "set-adv" }, el("summary", {}, "고급 값 (보통 바꿀 필요 없음)"));
  for (const key of ["conv_type", "template", "template_version", "recommended_llm"]) {
    if (!(key in s)) continue;
    const v = s[key];
    const isObj = v !== null && typeof v === "object";
    const inp = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "비우면 null" });
    inp.value = v == null ? "" : isObj ? JSON.stringify(v) : String(v);
    inp.addEventListener("input", () => {
      const t = inp.value.trim();
      if (isObj) { try { s[key] = t ? JSON.parse(t) : null; inp.classList.remove("bad"); } catch { inp.classList.add("bad"); return; } }
      else s[key] = t === "" ? (v === "" ? "" : null) : typeof v === "number" ? Number(t) : t;
      changed();
    });
    adv.append(el("div", { class: "field" }, el("label", {}, key), el("div", { class: "set-row" }, inp)));
  }
  if (adv.children.length > 1) form.append(adv);
  $("#pane").replaceChildren(paneHead(it), form);
}

// 상황 이미지: 전부 한 화면에 카드로
function renderImagesPane(it) {
  const imgs = S.working.circumstance_images ?? [];
  const changed = () => refreshTreeItem(it.id);
  const grid = el("div", { class: "img-grid" });
  imgs.forEach((img, i) => {
    const name = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "이름" });
    name.value = img.name ?? "";
    name.addEventListener("input", () => ((img.name = name.value), (tag.textContent = `{{img::${name.value}}}`), changed()));
    const circ = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "상황 설명" });
    circ.value = img.circumstance ?? "";
    circ.addEventListener("input", () => ((img.circumstance = circ.value), changed()));
    const tag = el("code", { class: "img-tag", title: "클릭하면 복사돼요" }, `{{img::${img.name ?? ""}}}`);
    tag.addEventListener("click", () => {
      navigator.clipboard?.writeText(tag.textContent).then(() => toast("이미지 태그를 복사했어요."), () => {});
    });
    grid.append(
      el(
        "div",
        { class: "img-card" },
        img.image ? el("img", { src: img.image, alt: img.name ?? "", loading: "lazy" }) : el("div", { class: "img-none" }, "이미지 없음"),
        el("div", { class: "img-meta" }, el("span", { class: "muted-num" }, `#${i + 1}`), tag),
        name,
        circ
      )
    );
  });
  $("#pane").replaceChildren(
    paneHead(it, [el("span", { class: "count" }, `${imgs.length}장`)]),
    el("div", { class: "hint" }, "이름과 상황 설명만 고칠 수 있어요. 이미지 파일 추가·교체·삭제는 티팟 미디어 관리에서 해 주세요. 시작 메시지에서는 {{img::이름}}으로 불러와요."),
    el("div", { class: "form" }, imgs.length ? grid : el("div", { class: "muted" }, "상황 이미지가 없어요."))
  );
}

// 시작 상황: 이름·상황 설명·시작 메시지 + 오른쪽 채팅 미리보기
function renderStartPane(it) {
  const st = S.working.start_settings[it.startIndex];
  const changed = () => refreshTreeItem(it.id);
  const form = el("div", { class: "form" });
  const nm = fieldInput({ id: `${it.id}#name`, kind: "line", limit: 20, get: () => st.setting_name, set: (v) => (st.setting_name = v), onChange: changed });
  form.append(formField("시작 상황 이름", nm.input, { count: nm.count, key: "setting_name" }));
  const ci = fieldInput({ id: `${it.id}#circ`, kind: "text", limit: 500, get: () => st.start_circumstance, set: (v) => (st.start_circumstance = v), onChange: changed });
  form.append(formField("시작 상황 설명", ci.input, { count: ci.count, note: "AI에게만 보여요", key: "start_circumstance", cls: "mid" }));
  const msg = fieldInput({ id: `${it.id}#msg`, kind: "html", limit: 3000, get: () => st.start_message, set: (v) => (st.start_message = v), onChange: changed });
  form.append(formField("시작 메시지", msg.input, { count: msg.count, note: "유저에게 보이는 첫 메시지 · HTML 가능", big: true, key: "start_message" }));
  const pv = makePreview({ variant: "chat", source: () => st.start_message ?? "", editor: () => msg.input.editor, jsx: () => startJsx(st) });
  S.onEdit = () => pv.update();
  $("#pane").replaceChildren(paneHead(it, [pv.toggle]), splitView(form, pv.el));
  nm.input.focus();
}

// 편집 칸 | 미리보기 나란히 놓기. 가운데 손잡이를 끌어 너비를 바꾸고, 바꾼 너비는 기억한다 (두 번 클릭하면 기본값).
function splitView(form, preview) {
  const handle = el("div", { class: "split-handle", title: "끌어서 너비 조절 · 두 번 클릭하면 기본 너비", role: "separator", "aria-orientation": "vertical" });
  const box = el("div", { class: "split" }, form, handle, preview);
  const apply = (w) => {
    if (w == null) return preview.style.removeProperty("width"), preview.classList.remove("sized");
    const max = Math.max(260, box.clientWidth - 280);
    preview.style.width = Math.round(Math.min(max, Math.max(260, w))) + "px";
    preview.classList.add("sized");
  };
  queueMicrotask(() => apply(store.get("previewWidth", null)));
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const right = box.getBoundingClientRect().right;
    const move = (ev) => apply(right - ev.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      store.set("previewWidth", parseInt(preview.style.width, 10) || null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    handle.addEventListener("pointercancel", up, { once: true });
  });
  handle.addEventListener("dblclick", () => (store.set("previewWidth", null), apply(null)));
  return box;
}

// ---------------- 티팟 미리보기 ----------------
const PREVIEW_CSS = `
*,::before,::after{box-sizing:border-box;border:0 solid;margin:0;padding:0}
html,body{background:#fff}
/* 티팟과 같은 글꼴 선언: Pretendard 가변 글꼴 하나를 굵기 범위 없이 등록한다.
   그래서 굵기 500 글자도 보통 굵기(400)로 그려지고, 굵게(strong)는 브라우저가 흉내 내 굵게 만든다. */
@font-face{font-family:tp-pretendard;src:url("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/variable/woff2/PretendardVariable.woff2") format("woff2");font-display:swap}
body{font-family:tp-pretendard,system-ui,sans-serif;color:oklch(14.5% 0 0);-webkit-font-smoothing:antialiased}
img,svg,video,canvas,audio,iframe,embed,object{display:block;vertical-align:middle}
img,video{max-width:100%;height:auto}
h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}
a{color:inherit;text-decoration:inherit}
ol,ul,menu{list-style:none}
table{border-collapse:collapse;text-indent:0;border-color:inherit}
button,input,select,textarea{font:inherit;color:inherit;background:transparent}
hr{height:0;color:inherit;border-top-width:1px}
summary{display:list-item;cursor:pointer}
.tp-frame{max-width:640px;margin:0 auto;padding:20px}
.tp-text{font-size:15px;letter-spacing:-0.02em;word-break:break-all;text-align:justify;text-justify:inter-word;line-height:1.75;font-weight:500}
.tp-root .tp-p{margin-bottom:1em}
.tp-root p:last-of-type{margin-bottom:0!important}
.tp-root h1{margin:12px 0;font-size:20px;line-height:28px;font-weight:700}
.tp-root h2{margin:8px 0;font-size:18px;line-height:28px;font-weight:700}
.tp-root h3{margin:8px 0;font-size:16px;line-height:24px;font-weight:600}
.tp-root ul{margin:8px 0;list-style:disc inside}
.tp-root ol{margin:8px 0;list-style:decimal inside}
.tp-root li+li{margin-top:4px}
.tp-root li>p{margin:0!important;display:inline}
.tp-root blockquote{margin:8px 0;border-left:4px solid #d1d5db;padding-left:16px;white-space:pre-wrap;color:#4b5563;font-style:italic}
.tp-root a{color:#2563eb}.tp-root a:hover{text-decoration:underline}
.tp-root code{border-radius:4px;padding:2px 4px;white-space:pre-wrap}
.tp-root pre{overflow-x:auto;border-radius:8px;padding:8px 12px;line-height:150%;white-space:pre-wrap;color:inherit;background:#FFFFFF66;border:1px solid #0000000D}
.tp-root table{display:block;overflow-x:auto}
.tp-root .tp-strong{font-weight:700}
/* 가이드라인 */
.guide .tp-text{color:oklch(14.5% 0 0)}
.guide .tp-root *{font-weight:inherit}
.guide .tp-root .tp-strong{font-weight:700}
.guide .tp-em{color:#374a64}
/* 채팅(시작 메시지) */
.chat .tp-text{color:#727272}
.chat .tp-root :not(strong){font-weight:inherit}
.chat .tp-p,.chat .tp-strong{color:#000}
.chat .tp-em{color:#727272}
.chat .tp-head{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.chat .tp-avatar{width:32px;height:32px;border-radius:50%;object-fit:cover;background:#eee}
.chat .tp-name{font-size:14px;font-weight:700;color:#111}
.chat .tp-msg{border-top:1.3px solid #0000001A;padding-top:20px}
.tp-jsx{margin:8px 0}
.tp-jsx iframe{display:block;width:100%;border:0;background:transparent;color-scheme:light}
.tp-jsx-text{white-space:pre-wrap;word-break:break-word}
.tp-jsx-img img{margin:16px auto;border-radius:8px}
.tp-missing{display:inline-block;padding:2px 6px;border:1px dashed #f59e0b;border-radius:4px;color:#b45309;font-size:12px}
/* 클릭 → 코드 줄 이동 */
.tp-hover{outline:2px solid rgba(59,130,246,.6)!important;outline-offset:1px;cursor:pointer}
.tp-hit{outline:2px solid #f59e0b!important;outline-offset:1px}
`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// 시작 메시지 변수 치환 (줄 수는 그대로 유지)
function chatSource(src) {
  const user = store.get("userName", "유저");
  const imgs = S.working.circumstance_images ?? [];
  return String(src ?? "")
    .replace(/\{char\}/g, S.working.char_name ?? "")
    .replace(/\{user\}/g, user)
    .replace(/\{\{img::([^}]*)\}\}/g, (m, name) => {
      const hit = imgs.find((x) => (x.name ?? "") === name.trim());
      return hit?.image ? `<img src="${esc(hit.image)}" alt="${esc(name)}">` : `<span class="tp-missing">이미지 없음: ${esc(name)}</span>`;
    });
}

// 미리보기 안의 외부 이미지(img·CSS 배경·@font-face)를 허브 중계 주소로 바꾼다.
// imgur 같은 곳은 로컬 주소(127.0.0.1)에서 온 요청을 막기 때문. 화면 모양과 코드 줄 번호는 그대로다.
const PROXY = (u) => `${location.origin}/img-proxy?u=${encodeURIComponent(u)}`;
const CSS_URL = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi;
function proxifyCss(css) {
  return css.replace(CSS_URL, (m, q, u) => `url(${q}${PROXY(u)}${q})`);
}
function proxifyImages(root) {
  for (const e of root.querySelectorAll("[style]")) {
    const s = e.getAttribute("style");
    if (/url\(/i.test(s)) e.setAttribute("style", proxifyCss(s));
  }
  for (const st of root.querySelectorAll("style")) {
    if (/url\(/i.test(st.textContent)) st.textContent = proxifyCss(st.textContent);
  }
  for (const img of root.querySelectorAll("img[src], source[src], video[poster]")) {
    for (const a of ["src", "poster"]) {
      const v = img.getAttribute(a);
      if (v && /^https?:\/\//i.test(v)) img.setAttribute(a, PROXY(v));
    }
  }
  for (const img of root.querySelectorAll("img[srcset], source[srcset]")) img.removeAttribute("srcset");
}

// 시작 상황에서 쓸 수 있는 JSX: 공용 JSX + 그 시작 상황의 JSX +(같은 이름이면 덮어씀).
// 꺼진 컴포넌트는 호출돼도 아무것도 그리지 않는다.
function startJsx(st) {
  const comps = {}, skip = new Set();
  for (const c of [...(S.working.jsx_components ?? []), ...(st?.additional_jsx_components ?? [])]) {
    if (!c?.name) continue;
    if (c.enabled === false) (delete comps[c.name], skip.add(c.name));
    else (comps[c.name] = c, skip.delete(c.name));
  }
  return { comps, skip };
}

function makePreview({ variant, source, editor, jsx }) {
  const jsxKey = () => {
    const { comps, skip } = jsx();
    return JSON.stringify([Object.values(comps).map((c) => [c.name, c.code]), [...skip]]);
  };
  // JSX를 끼워 넣으려면 미리보기 문서에서 스크립트가 돌아야 한다 (내용은 티팟 규칙대로 정리돼 script·on* 속성이 빠진다)
  const frame = el("iframe", { class: "pv-frame", sandbox: `allow-same-origin allow-popups${jsx ? " allow-scripts" : ""}`, referrerpolicy: "no-referrer", title: "미리보기" });
  const bar = el("div", { class: "pv-bar" }, el("span", {}, variant === "chat" ? "채팅 미리보기" : "가이드라인 미리보기"), el("span", { class: "pv-tip" }, "요소를 클릭하면 해당 코드 줄로 이동해요"));
  if (variant === "chat") {
    const u = el("input", { class: "pv-user", type: "text", title: "{user} 자리에 들어갈 이름", placeholder: "{user} 이름" });
    u.value = store.get("userName", "유저");
    u.addEventListener("input", () => (store.set("userName", u.value || "유저"), update(true)));
    bar.append(el("label", { class: "pv-userwrap" }, "{user} =", u));
  }
  const box = el("div", { class: "preview" }, bar, frame);
  let ready = false, timer, lastHtml = null;

  const skeleton = () => {
    const head = variant === "chat"
      ? `<div class="tp-head">${S.working.image ? `<img class="tp-avatar" src="${esc(S.working.image)}" alt="">` : `<div class="tp-avatar"></div>`}<span class="tp-name">${esc(S.working.char_name)}</span></div>`
      : "";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<style>${PREVIEW_CSS}</style></head><body class="${variant}"><div class="tp-frame">${head}<div class="${variant === "chat" ? "tp-msg " : ""}tp-text"><div class="tp-root"></div></div></div></body></html>`;
  };

  // 시작 메시지: 티팟처럼 글 조각과 JSX 조각으로 나눠 렌더링한다.
  // 조각마다 key를 두고 바뀐 조각만 다시 그린다 (JSX iframe이 매번 새로 뜨지 않게).
  const jsxHeights = new Map();
  function renderChat(doc, root, raw) {
    const { comps, skip } = jsx ? jsx() : { comps: {}, skip: new Set() };
    const items = [];
    const lineAt = (i) => raw.slice(0, i).split("\n").length;
    for (const seg of splitJsx(raw, new Set(Object.keys(comps)), true)) {
      if (seg.kind === "text") {
        if (!seg.value.trim()) continue;
        let html;
        try {
          html = TPV.renderTeapot(chatSource(seg.value), { scope: ".tp-root", lineOffset: lineAt(seg.start) - 1 });
        } catch (e) {
          html = `<pre style="color:#c00">렌더링 오류: ${esc(e.message)}</pre>`;
        }
        items.push({ key: "t:" + html, html });
        continue;
      }
      const lines = [lineAt(seg.start), lineAt(seg.end - 1)];
      const call = parseJsxCall(seg.inner.replace(/\{char\}/g, S.working.char_name ?? "").replace(/\{user\}/g, store.get("userName", "유저")));
      if (!call) continue;
      const comp = comps[call.name];
      if (!comp) {
        if (skip.has(call.name)) continue;
        const text = seg.inner.trim();
        if (text) items.push({ key: "u:" + text, html: `<span class="tp-jsx-text" data-src-line="${lines[0]}" data-src-end="${lines[1]}">${esc(text)}</span>` });
        continue;
      }
      const { props, urls } = extractJsxImages(call.props, S.working.circumstance_images);
      items.push({ key: "j:" + JSON.stringify([comp.name, comp.code, props]), comp, props, lines });
      for (const u of urls) items.push({ key: "i:" + u, html: `<div class="tp-jsx-img"><img src="${esc(u)}" alt=""></div>` });
    }
    // 바뀐 위치만 교체
    const old = [...root.children];
    if (old.some((n) => !n.dataset?.key)) (root.replaceChildren(), (old.length = 0));
    items.forEach((it, i) => {
      if (old[i]?.dataset.key === it.key) {
        // 그대로 두되, 위쪽 글이 바뀌어 줄 번호가 밀렸을 수 있으니 고쳐 둔다
        if (it.lines) (old[i].dataset.srcLine = it.lines[0]), (old[i].dataset.srcEnd = it.lines[1]);
        return;
      }
      const node = doc.createElement("div");
      node.dataset.key = it.key;
      if (it.comp) {
        node.className = "tp-jsx";
        node.dataset.srcLine = it.lines[0];
        node.dataset.srcEnd = it.lines[1];
        const f = doc.createElement("iframe");
        f.setAttribute("sandbox", "allow-scripts");
        f.setAttribute("title", `JSX ${it.comp.name}`);
        f.style.height = (jsxHeights.get(it.key) ?? 60) + "px";
        f._jsx = it;
        f.srcdoc = jsxSandboxDoc();
        node.append(f);
      } else {
        node.className = "tp-seg";
        node.innerHTML = it.html;
        proxifyImages(node);
      }
      if (old[i]) old[i].replaceWith(node);
      else root.append(node);
    });
    for (const n of old.slice(items.length)) n.remove();
  }
  // 끼워 넣은 JSX iframe들이 보내는 신호 (준비됨 → 컴파일해서 실행, 높이 변경, sendToChat)
  async function onJsxMessage(e) {
    const doc = frame.contentDocument;
    const f = [...(doc?.querySelectorAll(".tp-jsx iframe") ?? [])].find((x) => x.contentWindow === e.source);
    if (!f) return;
    const d = e.data || {}, it = f._jsx;
    if (d.type === "jsx-preview:height") {
      const h = Math.max(20, Math.min(4000, Number(d.height) || 0));
      f.style.height = h + "px";
      jsxHeights.set(it.key, h);
    } else if (d.type === "jsx-preview:chat") {
      toast("sendToChat 호출 (미리보기라 전송하지 않음): " + d.message);
    } else if (d.type === "jsx-preview:ready") {
      const code = String(it.comp.code ?? "");
      const v = validateJsx(code);
      if (!v.ok) return f.contentWindow?.postMessage({ type: "jsx-preview:init", error: `JSX ${it.comp.name}: 보안 검증을 통과하지 못했습니다.\n${v.errors.map((x) => `${x.line}:${x.column} ${x.message}`).join("\n")}` }, "*");
      const name = jsxComponentName(code.trim()) ?? it.comp.name;
      try {
        const compiled = await compileJsxCached(code, name);
        f.contentWindow?.postMessage({ type: "jsx-preview:init", compiledCode: compiled, componentName: name, props: it.props }, "*");
      } catch (err) {
        f.contentWindow?.postMessage({ type: "jsx-preview:init", error: `JSX ${it.comp.name} 문법 오류: ${String(err.message).replace(/^\/?preview\.tsx: /, "").split("\n")[0]}` }, "*");
      }
    }
  }

  function render() {
    const doc = frame.contentDocument;
    const root = doc?.querySelector(".tp-root");
    if (!root) return;
    let src = source();
    if (variant === "chat") {
      const key = JSON.stringify([src, jsx ? jsxKey() : null, store.get("userName", "유저")]);
      if (key === lastHtml) return;
      lastHtml = key;
      return renderChat(doc, root, String(src ?? ""));
    }
    let html;
    try {
      html = TPV.renderTeapot(src, { scope: ".tp-root" });
    } catch (e) {
      html = `<pre style="color:#c00">렌더링 오류: ${esc(e.message)}</pre>`;
    }
    if (html === lastHtml) return;
    lastHtml = html;
    root.innerHTML = html;
    proxifyImages(root);
  }
  function update(now = false) {
    clearTimeout(timer);
    if (!ready) return;
    if (now) render();
    else timer = setTimeout(render, 250);
  }

  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    ready = true;
    lastHtml = null;
    if (jsx) frame.contentWindow.addEventListener("message", onJsxMessage);
    render();
    let hovered = null;
    doc.addEventListener("mouseover", (e) => {
      const t = e.target.closest?.("[data-src-line]");
      if (hovered && hovered !== t) hovered.classList.remove("tp-hover");
      if (t) t.classList.add("tp-hover");
      hovered = t;
    });
    doc.addEventListener("mouseleave", () => hovered?.classList.remove("tp-hover"));
    doc.addEventListener("click", (e) => {
      const t = e.target.closest?.("[data-src-line]");
      if (!t) return;
      e.preventDefault();
      const ed = editor();
      if (!ed) return;
      ed.gotoLine(Number(t.dataset.srcLine), Number(t.dataset.srcEnd || t.dataset.srcLine));
      t.classList.add("tp-hit");
      setTimeout(() => t.classList.remove("tp-hit"), 900);
    });
  });
  frame.srcdoc = skeleton();

  const shown = store.get("showPreview", true);
  const toggle = el("button", { class: "small ghost" }, shown ? "미리보기 숨기기" : "미리보기 보기");
  toggle.addEventListener("click", () => {
    const on = !box.closest(".split").classList.toggle("no-preview");
    store.set("showPreview", on);
    toggle.textContent = on ? "미리보기 숨기기" : "미리보기 보기";
  });
  queueMicrotask(() => box.closest(".split")?.classList.toggle("no-preview", !shown));
  return { el: box, update, toggle };
}

// ---------------- 분량 막대 (티팟 제작창과 같은 계산) ----------------
const METER_COLORS = {
  default: "#303030", baseInfo: "rgba(243,117,0,0.7)", startSettingAddition: "rgba(0,223,130,0.45)",
  worldview: "rgba(49,139,244,0.75)", secret: "rgba(13,187,13,0.7)", exampleDialogue: "rgba(247,59,125,0.7)",
  outputFormat: "rgba(134,54,238,0.7)", simulationStatusUI: "rgba(223, 112, 235, 0.7)", statusUI: "rgba(203, 66, 66, 0.7)",
  jsxComponents: "rgba(20, 184, 166, 0.7)",
};
const SECTION_KEYS = ["baseInfo", "worldview", "secret", "exampleDialogue", "outputFormat", "jsx", "lorebook"];
const ADD_FIELD = { baseInfo: "additional_prompt", worldview: "additional_worldview", secret: "additional_secret", outputFormat: "additional_output_format" };
const joinAdd = (a, b) => {
  a = a ?? "";
  b = b ?? "";
  return !b.trim() ? a : !a.trim() ? b : `${a}\n\n${b}`;
};
const nonEmptyDialogs = (arr) => (arr ?? []).filter((d) => (d?.user ?? "").trim() || (d?.char ?? "").trim());
const namedJsx = (arr) => (arr ?? []).filter((x) => (x?.name ?? "").trim());
const validBooks = (arr) =>
  Array.isArray(arr)
    ? arr.filter((e) => e && typeof e === "object" && ((typeof e.info === "string" && e.info.trim()) || (Array.isArray(e.keys) && e.keys.some((k) => typeof k === "string" && k.trim()))))
    : [];
const dialogChars = (arr) => (arr ?? []).reduce((a, d) => a + (d?.user ?? "").length + (d?.char ?? "").length, 0);
function mergeJsx(common, add) {
  const out = [], idx = new Map();
  const put = (e) => {
    const n = (e?.name ?? "").trim();
    if (n && idx.has(n)) return void (out[idx.get(n)] = e);
    if (n) idx.set(n, out.length);
    out.push(e);
  };
  (common ?? []).forEach(put);
  namedJsx(add).forEach(put);
  return out;
}
function jsxText(arr) {
  let t = "";
  for (const d of arr ?? []) {
    if (!d?.enabled) continue;
    t += (d.name ?? "") + (d.display_name ?? "") + (d.description ?? "");
    for (const p of d.props ?? []) t += (p.name ?? "") + (p.description ?? "") + (p.example ?? "");
  }
  return t;
}
function hasAddition(st, k) {
  if (!st) return false;
  if (k === "exampleDialogue") return nonEmptyDialogs(st.additional_example_dialogues).length > 0;
  if (k === "jsx") return namedJsx(st.additional_jsx_components).length > 0;
  if (k === "lorebook") return validBooks(st.additional_keyword_books).length > 0;
  return (st[ADD_FIELD[k]] ?? "").trim().length > 0;
}
function variantOf(s, st, index, counted) {
  const f = {
    prompt: joinAdd(s.prompt, st?.additional_prompt),
    worldview: joinAdd(s.worldview, st?.additional_worldview),
    secret: joinAdd(s.secret, st?.additional_secret),
    example_dialogues: [...(s.example_dialogues ?? []), ...nonEmptyDialogs(st?.additional_example_dialogues)],
    output_format_prompt: joinAdd(s.output_format_prompt, st?.additional_output_format),
    jsx_components: mergeJsx(s.jsx_components, st?.additional_jsx_components),
  };
  const g = { baseInfo: (s.prompt ?? "").length, worldview: (s.worldview ?? "").length, secret: (s.secret ?? "").length, exampleDialogue: dialogChars(s.example_dialogues), outputFormat: (s.output_format_prompt ?? "").length, jsx: jsxText(s.jsx_components).length, lorebook: 0 };
  const b = { baseInfo: f.prompt.length, worldview: f.worldview.length, secret: f.secret.length, exampleDialogue: dialogChars(f.example_dialogues), outputFormat: f.output_format_prompt.length, jsx: jsxText(f.jsx_components).length, lorebook: 0 };
  const commonChars = {}, additionChars = {};
  let totalAdditionChars = 0, countedChars = 0;
  for (const k of SECTION_KEYS) {
    const a = Math.max(0, b[k] - g[k]);
    additionChars[k] = a;
    commonChars[k] = b[k] - a;
    if (counted(k)) (totalAdditionChars += a), (countedChars += b[k]);
  }
  return { settingIndex: index, fields: f, commonChars, additionChars, totalAdditionChars, countedChars };
}
function longestVariant(s, counted) {
  let best = variantOf(s, null, null, counted);
  (s.start_settings ?? []).forEach((st, i) => {
    if (!SECTION_KEYS.some((k) => hasAddition(st, k))) return;
    const v = variantOf(s, st, i, counted);
    if (v.countedChars > best.countedChars) best = v;
  });
  return best;
}

function computeMeter(s) {
  const mode = s.prompt_mode === "detail" ? "detail" : "simple";
  const tpl = S.templates?.filter((t) => !t.prompt_mode || t.prompt_mode === mode) ?? [];
  const chosen = tpl.find((t) => t.name === s.template) ?? tpl.find((t) => t.name === "general") ?? tpl[0];
  const base = Number(chosen?.num_chars) || 0;
  const custom = typeof s.template === "string" && s.template.toLowerCase() === "custom";
  const counted = (k) => k === "baseInfo" || k === "jsx" || k === "lorebook" || !custom;
  const w = longestVariant(s, counted);
  const startName = w.settingIndex != null ? (s.start_settings?.[w.settingIndex]?.setting_name ?? "").trim() || `시작 상황 ${w.settingIndex + 1}` : "";
  const simUI = (s.characters ?? []).reduce((a, c) => a + (c?.name ?? "").length + (c?.description ?? "").length, 0);
  const statusUI = (s.simulation_status?.status_description ?? "").length + (s.simulation_status?.status_variable_constraint ?? "").length;
  const imgChars = (s.circumstance_images ?? []).reduce((a, x) => a + (x?.name ?? "").length + (x?.circumstance ?? "").length, 0);
  const jsxAll = jsxText(w.fields.jsx_components);
  const total = base + w.countedChars + simUI + statusUI + imgChars;
  const scale = Math.max(32000, total);
  const segs = [];
  const push = (title, n, color) => n > 0 && segs.push({ title, n, color, pct: (n / scale) * 100 });
  push("기본 프롬프트", Math.min(base, total), METER_COLORS.default);
  if (total > base) {
    const c = w.commonChars;
    push("기본정보", c.baseInfo, METER_COLORS.baseInfo);
    push("세계관", c.worldview, METER_COLORS.worldview);
    push("비밀설정", c.secret, METER_COLORS.secret);
    push("예시대화", c.exampleDialogue, METER_COLORS.exampleDialogue);
    push(`시작 상황-${startName}`, w.totalAdditionChars, METER_COLORS.startSettingAddition);
    push("출력형식", c.outputFormat, METER_COLORS.outputFormat);
    push("다인 채팅 UI", simUI, METER_COLORS.simulationStatusUI);
    push("상태 UI", statusUI, METER_COLORS.statusUI);
    push("JSX", c.jsx, METER_COLORS.jsxComponents);
  }
  const promptText = [
    w.fields.prompt, w.fields.worldview, w.fields.secret,
    ...w.fields.example_dialogues.flatMap((d) => [d.user, d.char]),
    w.fields.output_format_prompt,
    ...(s.characters ?? []).flatMap((c) => [c.name, c.description]),
    s.simulation_status?.status_description, s.simulation_status?.status_variable_constraint,
    ...(s.circumstance_images ?? []).flatMap((x) => [x.name, x.circumstance]),
    jsxAll,
  ].filter((x) => typeof x === "string" && x.length > 0).join("\n");
  return { mode, total, segs, startName, promptText, templateFound: !!chosen };
}

const TIERS = [[12000, "정량제 · 짧음"], [20000, "정량제 · 보통"], [32000, "정량제 · 긴"], [Infinity, "종량제 전용"]];
const tokenCache = new Map();
let tokenTimer;

async function ensureTemplates() {
  if (S.templates || S.templatesLoading || !S.tabs.length) return;
  S.templatesLoading = true;
  try {
    S.templates = await hub("templates");
  } catch {
    S.templates = null;
  } finally {
    S.templatesLoading = false;
  }
  updateMeter();
}

function updateMeter() {
  const m = $("#meter");
  if (!S.working) return m.classList.add("hidden");
  m.classList.remove("hidden");
  ensureTemplates();
  const r = computeMeter(S.working);
  const tier = TIERS.find(([max]) => r.total <= max)[1];
  const payg = r.total > 32000;
  $("#meterBar").replaceChildren(
    ...r.segs.map((sg) => el("div", { class: "seg", style: `width:${sg.pct}%;background:${sg.color}`, title: `${sg.title} · ${sg.n.toLocaleString()}자` }))
  );
  $("#meterChars").textContent = `${r.total.toLocaleString()}자`;
  const badge = $("#meterBadge");
  badge.textContent = payg ? "종량제" : "정량제";
  badge.className = "badge " + (payg ? "payg" : "fixed");
  badge.title = `${tier}\n정량제: 짧음 12,000자 미만 · 보통 ~20,000자 · 긴 ~32,000자 / 32,000자 초과는 종량제 전용\n등록 상한 400,000자`;
  $("#meterNote").textContent = [
    r.startName ? `기준: 가장 긴 시작 상황 「${r.startName}」` : "",
    r.mode === "detail" ? "상세 모드는 근사치예요 (템플릿 섹션 문구 미반영)" : "",
    r.total > 400000 ? "⚠ 등록 상한(400,000자) 초과" : "",
    !r.templateFound && S.templates ? "템플릿 기본 글자 수를 못 찾음" : "",
  ].filter(Boolean).join(" · ");
  // 토큰: 티팟과 같은 서버 API로 (입력이 멈추고 0.8초 뒤)
  const tk = $("#meterTokens");
  const text = r.promptText;
  if (tokenCache.has(text)) {
    tk.textContent = `입력 ${tokenCache.get(text).toLocaleString()} 토큰`;
    return;
  }
  tk.textContent = S.tabs.length ? "토큰 계산 중…" : "토큰: 티팟 탭 필요";
  clearTimeout(tokenTimer);
  if (!S.tabs.length) return;
  tokenTimer = setTimeout(async () => {
    try {
      const n = await hub("countTokens", { text });
      tokenCache.set(text, n);
      if (tokenCache.size > 50) tokenCache.delete(tokenCache.keys().next().value);
      updateMeter();
    } catch {
      tk.textContent = "토큰 계산 실패";
    }
  }, 800);
}

function revertItem(it) {
  if (it.kind === "info") {
    for (const k of ["char_name", "oneline_description", "detail_description", "hash_tags"]) S.working[k] = clone(S.original[k]);
    refreshTreeItem(it.id);
    return renderPane();
  }
  if (it.kind === "start") {
    const o = S.original.start_settings?.[it.startIndex];
    if (!o) return toast("새로 추가한 시작 상황이에요. 지우려면 폴더의 삭제를 누르세요.");
    const w = S.working.start_settings[it.startIndex];
    for (const k of ["setting_name", "start_circumstance", "start_message"]) w[k] = clone(o[k]);
    refreshTreeItem(it.id);
    return renderPane();
  }
  if (it.kind === "images") {
    S.working.circumstance_images = clone(S.original.circumstance_images);
    refreshTreeItem(it.id);
    return renderPane();
  }
  if (it.kind === "status") {
    if (S.original.simulation_status === undefined) delete S.working.simulation_status;
    else S.working.simulation_status = clone(S.original.simulation_status);
    refreshTreeItem(it.id);
    return renderPane();
  }
  const orig = itemGet(it, S.original);
  if (orig === undefined && it.kind === "record") return toast("새로 추가한 항목이에요. 지우려면 삭제를 누르세요.");
  itemSet(it, S.working, clone(orig ?? (it.kind === "json" ? null : "")));
  for (const k of [...S.jsonDrafts.keys()]) if (k === it.id || k.startsWith(it.id + "#")) S.jsonDrafts.delete(k);
  refreshTreeItem(it.id);
  renderPane();
}

// ---------------- 목록 항목 추가/복제/삭제/이동 ----------------
function listArr(path) {
  let arr = getPath(S.working, path);
  if (!Array.isArray(arr)) setPath(S.working, path, (arr = []));
  return arr;
}
function fixLabels(arr) {
  // 티팟은 로어북에 indexLabel(1,2,3…)을 붙인다. 원래 있던 목록이면 순서대로 다시 매긴다.
  if (arr.some((x) => x && typeof x === "object" && "indexLabel" in x)) arr.forEach((x, i) => x && typeof x === "object" && (x.indexLabel = i + 1));
}
function clearJsonDrafts(prefix) {
  for (const k of [...S.jsonDrafts.keys()]) if (k.startsWith(prefix)) S.jsonDrafts.delete(k);
}
function addRecord(path) {
  const schema = LIST_SCHEMAS[path[path.length - 1]];
  const arr = listArr(path);
  if (schema.max && arr.length >= schema.max) return toast(`${schema.label}은(는) 최대 ${schema.max}개까지예요.`, true);
  const rec = typeof schema.empty === "function" ? schema.empty() : clone(schema.empty ?? {});
  if (rec && typeof rec === "object" && !rec.id && arr.some((x) => x?.id)) rec.id = crypto.randomUUID();
  arr.push(rec);
  fixLabels(arr);
  closed.delete("list:" + path.join("."));
  renderTree();
  select([...path, arr.length - 1].join("."));
}
function duplicateRecord(it) {
  const arr = listArr(it.listPath);
  if (it.schema.max && arr.length >= it.schema.max) return toast(`${it.schema.label}은(는) 최대 ${it.schema.max}개까지예요.`, true);
  const copy = clone(arr[it.index]);
  if (copy && typeof copy === "object") {
    if (copy.id) copy.id = crypto.randomUUID();
    for (const k of it.schema.newIds ?? []) copy[k] = crypto.randomUUID();
    if ("code" in copy && copy.name) {
      // 티팟과 같은 방식: 이름 뒤에 Copy를 붙이고 코드 안의 함수 이름도 바꾼다
      const nn = copy.name + "Copy";
      copy.code = String(copy.code ?? "").replace(new RegExp(`\\b${copy.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), nn);
      copy.name = nn;
      if (copy.display_name) copy.display_name += " 복사";
      it.schema.afterSet?.(copy, "code");
    } else {
      const tk = it.schema.titleKey;
      if (tk && typeof copy[tk] === "string") copy[tk] += " (복사)";
    }
  }
  arr.splice(it.index + 1, 0, copy);
  fixLabels(arr);
  clearJsonDrafts(it.listPath.join("."));
  renderTree();
  select([...it.listPath, it.index + 1].join("."));
}
function removeRecord(it) {
  if (!confirm(`「${it.label}」을(를) 삭제할까요? (저장해야 반영돼요)`)) return;
  const arr = listArr(it.listPath);
  arr.splice(it.index, 1);
  fixLabels(arr);
  clearJsonDrafts(it.listPath.join("."));
  if (S.current?.startsWith(it.listPath.join(".") + ".")) S.current = null;
  renderTree();
  renderPane();
}
function moveRecord(it, d) {
  const arr = listArr(it.listPath);
  const j = it.index + d;
  if (j < 0 || j >= arr.length) return;
  [arr[it.index], arr[j]] = [arr[j], arr[it.index]];
  fixLabels(arr);
  clearJsonDrafts(it.listPath.join("."));
  renderTree();
  select([...it.listPath, j].join("."));
}

// ---------------- 시작 상황 추가/복제/삭제 ----------------
const EMPTY_START = {
  setting_name: "", start_circumstance: "", start_message: "", recommended_answers: [],
  additional_prompt: "", additional_worldview: "", additional_secret: "", additional_example_dialogues: [],
  additional_output_format: "", additional_keyword_books: [],
};
function blankLike(obj) {
  // 기존 시작 상황과 같은 키를 갖도록 빈 값으로 만든다
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = Array.isArray(v) ? [] : typeof v === "string" ? "" : v && typeof v === "object" ? {} : v;
  return out;
}
function addStart() {
  const list = (S.working.start_settings ??= []);
  list.push({ ...EMPTY_START, ...blankLike(list[0]), setting_name: `시작 상황 ${list.length + 1}` });
  closed.delete("starts");
  renderTree();
  select(`start_settings.${list.length - 1}.start_circumstance`);
}
function duplicateStart(i) {
  const list = S.working.start_settings;
  const copy = clone(list[i]);
  copy.setting_name = (copy.setting_name || `시작 상황 ${i + 1}`) + " (복사)";
  list.splice(i + 1, 0, copy);
  clearJsonDrafts("start_settings.");
  renderTree();
  select(`start_settings.${i + 1}.setting_name`);
}
function removeStart(i) {
  const list = S.working.start_settings;
  if (list.length <= 1) return toast("시작 상황은 최소 하나 있어야 해요.", true);
  if (!confirm(`「${list[i].setting_name || `시작 상황 ${i + 1}`}」을(를) 삭제할까요? (저장해야 반영돼요)`)) return;
  list.splice(i, 1);
  clearJsonDrafts("start_settings.");
  if (S.current?.startsWith("start_settings.")) S.current = null;
  renderTree();
  renderPane();
}

// ---------------- 불러오기 / 저장 ----------------
function ts(t) {
  return t?._seconds ? t._seconds * 1000 + Math.round((t._nanoseconds ?? 0) / 1e6) : 0;
}
function fmt(t) {
  const n = ts(t);
  return n ? new Date(n).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}
const STATUS_LABEL = { AUTO_SAVED: "⟳ ", ACCEPTED: "✓ " };

async function loadCheckpoints() {
  const r = await call("listCheckpoints", { characterId: S.cid, summaryOnly: true });
  const sel = $("#cpSelect");
  const cps = r.checkpoints ?? [];
  sel.replaceChildren(
    ...cps.map((c) =>
      el("option", { value: c.id }, `${STATUS_LABEL[c.cp_status] ?? ""}${c.name}${fmt(c.time_saved) ? " · " + fmt(c.time_saved) : ""}`)
    )
  );
  if (!S.cpid || !cps.some((c) => c.id === S.cpid)) S.cpid = cps.find((c) => c.cp_status !== "AUTO_SAVED")?.id ?? cps[0]?.id ?? null;
  sel.value = S.cpid ?? "";
}

async function load({ keepCurrent = true } = {}) {
  if (!S.cid) return;
  setBusy(true);
  try {
    await loadCheckpoints();
    if (!S.cpid) throw new Error("저장본이 없어요.");
    const r = await call("getCheckpoint", { characterId: S.cid, checkpointId: S.cpid });
    S.checkpoint = r.checkpoint;
    S.original = clone(r.checkpoint.snapshot);
    S.working = clone(r.checkpoint.snapshot);
    S.jsonDrafts.clear();
    S.stashedStatus = null;
    $("#charName").textContent = S.working.char_name || "(제목 없음)";
    hideBanner();
    if (isLocked()) showBanner("이 저장본은 심사 중이거나 등록 완료된 버전이라 덮어쓸 수 없어요. 저장하면 새 저장본으로 저장돼요.");
    $("#btnSave").textContent = isLocked() ? "새 저장본으로 저장" : "저장";
    renderTree();
    const want = keepCurrent ? S.current ?? store.get("current", null) : null;
    S.current = ITEMS.has(want) ? want : "prompt";
    select(S.current);
    store.set("last", { cid: S.cid, cpid: S.cpid });
    updateMeter();
    updateTabButton();
  } catch (e) {
    toast(e.message, true);
  } finally {
    setBusy(false);
  }
}

// prompt_char_count는 티팟이 등록(submit)할 때 직접 계산해 넣는 값(요금제 판정용)이라 건드리지 않는다.
function snapshotForSave() {
  return clone(S.working);
}

// 심사 중·등록 완료 저장본은 서버가 덮어쓰기를 막는다 → 새 저장본으로 저장
const isLocked = () => !!S.checkpoint?.cp_status && S.checkpoint.cp_status !== "AUTO_SAVED";

function nextCheckpointName() {
  const nums = [...$("#cpSelect").options].map((o) => Number(/제목없음 (\d+)/.exec(o.textContent)?.[1] ?? 0));
  return `제목없음 ${Math.max(0, ...nums) + 1}`;
}

async function save({ asNew = false } = {}) {
  if (!S.working || S.busy) return;
  if ([...S.jsonDrafts.values()].some((d) => d.error)) return toast("JSON 형식 오류가 있는 항목을 먼저 고쳐주세요.", true);
  if (!asNew && !anyDirty()) return;
  if (!asNew && isLocked()) asNew = true;
  let name = null;
  if (asNew) {
    name = prompt(
      isLocked() ? "이 저장본은 심사 중이거나 등록 완료라 덮어쓸 수 없어요. 새 저장본 이름:" : "새 저장본 이름",
      nextCheckpointName()
    );
    if (!name) return;
  }
  setBusy(true);
  try {
    let cpid = S.cpid;
    const snapshot = snapshotForSave();
    if (asNew) {
      const r = await call("createCheckpoint", { characterId: S.cid, name, snapshot });
      cpid = r?.checkpoint?.id ?? cpid;
    } else {
      const latest = await call("getCheckpoint", { characterId: S.cid, checkpointId: S.cpid });
      if (ts(latest.checkpoint.time_saved) !== ts(S.checkpoint.time_saved)) {
        const ok = confirm(
          `불러온 뒤 다른 곳(티팟 제작창이나 Claude)에서 이 저장본이 저장됐어요 (${fmt(latest.checkpoint.time_saved)}).\n\n` +
            "[확인] 내 편집 내용으로 덮어쓰기\n[취소] 저장 안 함"
        );
        if (!ok) return;
      }
      await call("updateCheckpoint", { characterId: S.cid, cpId: S.cpid, snapshot });
    }
    S.cpid = cpid;
    setBusy(false);
    await load();
    toast(asNew ? `새 저장본 「${name}」으로 저장했어요.` : "저장했어요.");
    if ($("#optReload").checked) reloadTeapotTab(cpid);
  } catch (e) {
    toast("저장 실패: " + e.message, true);
  } finally {
    setBusy(false);
  }
}

async function reloadTeapotTab(cpid) {
  const tab = S.tabs.at(-1);
  if (!tab || tab.cid !== S.cid || !String(tab.url).startsWith("/creator/")) return;
  try {
    await hub("reload", { cpid });
  } catch {}
}

function setBusy(b) {
  S.busy = b;
  for (const id of ["#btnSave", "#btnSaveNew", "#btnReload"]) $(id).disabled = b;
  if (!b) updateTitleDirty();
  document.body.style.cursor = b ? "progress" : "";
}

// ---------------- 연결 / 이벤트 ----------------
function setConn(tabs) {
  S.tabs = tabs ?? [];
  const c = $("#conn");
  const ok = S.tabs.length > 0;
  c.className = "conn " + (ok ? "ok" : "bad");
  c.lastElementChild.textContent = ok ? "티팟 탭 연결됨" : "티팟 탭 없음";
  c.title = ok ? S.tabs.at(-1).title + "\n" + S.tabs.at(-1).url : "teapotchat.com 제작창을 열어주세요 (유저스크립트 필요)";
  updateTabButton();
}

function updateTabButton() {
  const tab = S.tabs.at(-1);
  $("#btnTabChar").classList.toggle("hidden", !(tab?.cid && S.cid && tab.cid !== S.cid));
}

async function adoptTab() {
  const tab = S.tabs.at(-1);
  if (!tab?.cid) return;
  if (anyDirty() && !confirm("저장하지 않은 변경 내용이 사라져요. 계속할까요?")) return;
  S.cid = tab.cid;
  S.cpid = tab.cpid;
  S.current = null;
  await load({ keepCurrent: false });
}

function onSaved(ev) {
  if (ev.source === "editor" || ev.characterId !== S.cid) return;
  const who = ev.source === "claude" ? "Claude" : "다른 곳";
  if (ev.fn === "createCheckpoint") {
    loadCheckpoints().catch(() => {});
    return toast(`${who}가 새 저장본을 만들었어요.`);
  }
  if (ev.checkpointId !== S.cpid) return;
  if (!anyDirty()) {
    load().then(() => toast(`${who}가 저장한 내용을 불러왔어요.`));
  } else {
    showBanner(`${who}가 이 저장본을 저장했어요. 지금 편집 중인 내용과 다를 수 있어요.`, "불러오기 (내 변경 버림)", () => load());
  }
}

// 허브와의 실시간 채널 (WebSocket). 끊기면 2초 뒤 다시 연결한다.
function connectEvents() {
  const ws = new WebSocket(`ws://${location.host}/api/live`);
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "tabs") {
      setConn(ev.tabs);
      if (!started) start();
    } else if (ev.type === "saved") onSaved(ev);
  };
  ws.onclose = () => {
    setConn([]);
    $("#conn").lastElementChild.textContent = "허브 연결 끊김";
    setTimeout(connectEvents, 2000);
  };
}

let started = false;
async function start() {
  if (started) return;
  const tab = S.tabs.at(-1);
  const last = store.get("last", null);
  if (tab?.cid) {
    S.cid = tab.cid;
    S.cpid = tab.cpid || (last?.cid === tab.cid ? last.cpid : null);
  } else if (last?.cid) {
    S.cid = last.cid;
    S.cpid = last.cpid;
  }
  if (!S.cid) {
    $("#pane").replaceChildren(el("div", { class: "empty" }, "teapotchat.com에서 캐릭터 제작창을 열면 여기서 편집할 수 있어요."));
    return;
  }
  if (!S.tabs.length) {
    $("#pane").replaceChildren(el("div", { class: "empty" }, "티팟 탭이 연결되면 불러올게요…"));
    return;
  }
  started = true;
  if (last?.cid !== S.cid) S.current = null;
  await load({ keepCurrent: last?.cid === S.cid });
}

// ---------------- 배너 / 토스트 ----------------
function showBanner(msg, actionLabel, action) {
  const b = $("#banner");
  b.replaceChildren(
    ...[
      el("span", {}, msg),
      actionLabel ? el("button", { class: "small", onclick: action }, actionLabel) : null,
      el("button", { class: "small ghost", onclick: hideBanner }, "닫기"),
    ].filter(Boolean)
  );
  b.classList.remove("hidden");
}
function hideBanner() {
  $("#banner").classList.add("hidden");
}
let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), error ? 6000 : 2500);
}

// ---------------- 이벤트 바인딩 ----------------
S.showCommon = store.get("showCommon", true);
$("#optReload").checked = store.get("optReload", true);
$("#optReload").addEventListener("change", (e) => store.set("optReload", e.target.checked));
$("#btnSave").addEventListener("click", () => save());
$("#btnSaveNew").addEventListener("click", () => save({ asNew: true }));
$("#btnReload").addEventListener("click", () => {
  if (anyDirty() && !confirm("저장하지 않은 변경 내용이 사라져요. 다시 불러올까요?")) return;
  load();
});
$("#btnTabChar").addEventListener("click", adoptTab);
$("#cpSelect").addEventListener("change", (e) => {
  if (anyDirty() && !confirm("저장하지 않은 변경 내용이 사라져요. 다른 저장본을 열까요?")) {
    e.target.value = S.cpid;
    return;
  }
  S.cpid = e.target.value;
  load();
});
let filterTimer;
$("#treeFilter").addEventListener("input", (e) => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    S.filter = e.target.value.trim().toLowerCase();
    if (S.working) renderTree();
  }, 150);
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && e.shiftKey) {
    e.preventDefault();
    $("#treeFilter").focus();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (anyDirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// 새 버전 알림 (GitHub 저장소의 버전과 비교). "닫기"를 누르면 그 버전은 다시 알리지 않는다.
async function checkUpdate() {
  try {
    const u = await fetch("/api/update").then((r) => r.json());
    if (!u.newer || store.get("updateDismissed", null) === u.latest) return;
    const note = $("#updateNote");
    const link = el("a", { href: `${u.repo}#업데이트`, target: "_blank", rel: "noopener", title: `지금 버전 ${u.current} → 새 버전 ${u.latest}` }, `새 버전 ${u.latest}이 있어요 · 업데이트 방법`);
    const close = el("button", { class: "update-close", title: "이 버전 알림 닫기", "aria-label": "알림 닫기" }, "×");
    close.addEventListener("click", () => (store.set("updateDismissed", u.latest), note.classList.add("hidden")));
    note.replaceChildren(link, close);
    note.classList.remove("hidden");
  } catch {}
}

connectEvents();
checkUpdate();
setInterval(() => {
  if (!started && S.tabs.length) start();
}, 1000);
