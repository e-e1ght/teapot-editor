"use strict";
// JSX 컴포넌트 미리보기 — 티팟 제작창과 같은 방식으로 검증·컴파일·실행한다.
//  - 검증: 티팟 저장 전 보안 검사와 같은 규칙
//  - 컴파일: Babel standalone 7.25.6 (presets: react + typescript TSX), 코드를 IIFE로 감싸 컴포넌트를 등록
//  - 실행: 다른 출처로 격리된 iframe(sandbox="allow-scripts") 안의 React 18.3.1, 티팟과 같은 CSP
//  - 미리보기 props: 각 prop의 예시값 (number는 숫자, boolean은 true/1/yes/on, 나머지는 문자열 그대로)

const JSX_REACT = "https://unpkg.com/react@18.3.1/umd/react.production.min.js";
const JSX_REACT_DOM = "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js";
const JSX_BABEL = ["https://unpkg.com/@babel/standalone@7.25.6/babel.min.js", "https://cdn.jsdelivr.net/npm/@babel/standalone@7.25.6/babel.min.js"];
const JSX_THREE = "https://unpkg.com/three@0.160.0/build/three.min.js";

// ---------- 티팟 보안 검증 (원본 규칙 그대로) ----------
const JSX_NAME_FN = /function\s+([A-Z][A-Za-z0-9]*)\s*\(/;
const JSX_NAME_CONST = /(?:const|let|var)\s+([A-Z][A-Za-z0-9]*)\s*(?::[^=]*?)?=\s*(?:async\s+)?\(/;
function jsxComponentName(code) {
  const a = JSX_NAME_FN.exec(code), b = JSX_NAME_CONST.exec(code);
  const m = a && b ? (a.index <= b.index ? a : b) : a ?? b;
  return m ? m[1] : null;
}
function jsxPos(code, idx) {
  let line = 1, last = -1;
  for (let i = 0; i < idx; i++) if (code.charCodeAt(i) === 10) (line++, (last = i));
  return { line, column: idx - last };
}
function validateJsx(code) {
  if (!code.trim()) return { ok: false, errors: [{ message: "코드가 비어 있습니다.", line: 1, column: 1 }] };
  const ie = /(?:^|\n)[ \t]*(import|export)\b/.exec(code);
  if (ie) {
    const p = jsxPos(code, ie.index + ie[0].indexOf(ie[1]));
    return { ok: false, errors: [{ message: `'${ie[1]}' 문은 사용할 수 없습니다. React·Hooks 는 자동 제공되니 import 없이 바로 쓰고, export 없이 function PascalCase(...) 로 선언하세요.`, ...p }] };
  }
  if (!jsxComponentName(code.trim())) {
    return { ok: false, errors: [{ message: "function PascalCase(...) { ... } 또는 const PascalCase = (...) => { ... } 형식의 함수 컴포넌트로 작성해주세요.", line: 1, column: 1 }] };
  }
  const errors = [];
  for (const tag of ["script", "iframe", "embed", "object", "link", "meta", "base"]) {
    for (const m of code.matchAll(new RegExp(`<\\s*${tag}(\\s|>|/)`, "gi"))) errors.push({ message: `허용되지 않은 태그: <${tag}>`, ...jsxPos(code, m.index) });
  }
  for (const attr of ["dangerouslySetInnerHTML", "srcDoc", "srcdoc", "formAction", "formaction"]) {
    for (const m of code.matchAll(new RegExp(`\\b${attr}\\s*=`, "g"))) errors.push({ message: `허용되지 않은 속성: ${attr}`, ...jsxPos(code, m.index) });
  }
  for (const [re, label] of [
    [/\bwindow\s*\.\s*(parent|top|opener|frames)\b/g, "window.parent/top/opener 접근"],
    [/\bparent\s*\.\s*postMessage\b/g, "parent.postMessage 호출"],
    [/\beval\s*\(/g, "eval 호출"],
    [/\bnew\s+Function\s*\(/g, "new Function 생성"],
  ]) {
    for (const m of code.matchAll(re)) errors.push({ message: `보안상 차단된 패턴: ${label}`, ...jsxPos(code, m.index) });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---------- 미리보기 props (티팟과 같은 변환) ----------
function jsxSampleProps(props) {
  const out = {};
  for (const p of props ?? []) {
    if (!p?.name || !p.example?.trim()) continue;
    if (p.type === "number") {
      const n = Number(p.example);
      if (Number.isFinite(n)) out[p.name] = n;
    } else if (p.type === "boolean") out[p.name] = /^(true|1|yes|on)$/i.test(p.example.trim());
    else out[p.name] = p.example;
  }
  return out;
}

// ---------- Babel (처음 한 번만 불러온다) ----------
let babelLoading = null;
function loadBabel() {
  if (window.Babel) return Promise.resolve(window.Babel);
  if (babelLoading) return babelLoading;
  const tryLoad = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => (window.Babel ? resolve(window.Babel) : reject(new Error("Babel 없음")));
      s.onerror = () => reject(new Error("Babel을 불러오지 못했습니다: " + src));
      document.head.appendChild(s);
    });
  babelLoading = tryLoad(JSX_BABEL[0]).catch(() => tryLoad(JSX_BABEL[1])).catch((e) => {
    babelLoading = null;
    throw e;
  });
  return babelLoading;
}
async function compileJsx(code, name) {
  const Babel = await loadBabel();
  const wrapped = `(function(){\n${code}\n;window.__teapotSetComponent__(${name});\n})();`;
  return Babel.transform(wrapped, { presets: ["react", ["typescript", { isTSX: true, allExtensions: true }]], filename: "preview.tsx" }).code;
}

// ---------- 격리된 실행 문서 ----------
function jsxSandboxDoc() {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://unpkg.com; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';" />
<meta name="referrer" content="no-referrer" />
<meta name="color-scheme" content="light" />
<style>
  html, body { color-scheme: light; margin: 0; padding: 0; box-sizing: border-box; background: transparent; -webkit-tap-highlight-color: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #222; font-size: 13px; }
  .jsx-error { color: #d11; font-weight: 600; padding: 8px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; }
  .jsx-loading { color: #888; padding: 8px; font-size: 12px; }
</style></head>
<body><div id="root"><div class="jsx-loading">컴포넌트 로딩 중...</div></div>
<script src="${JSX_REACT}" crossorigin="anonymous"></script>
<script src="${JSX_REACT_DOM}" crossorigin="anonymous"></script>
<script>
(function () {
  var reactRoot = null, registered = null, lastCode = null, lastComp = null;
  var pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, buttons: 0 };
  ['pointerdown','pointermove','pointerup','pointerleave','pointercancel'].forEach(function (t) {
    document.addEventListener(t, function (e) {
      var px = pointer.x, py = pointer.y;
      pointer.x = e.clientX || 0; pointer.y = e.clientY || 0; pointer.dx = pointer.x - px; pointer.dy = pointer.y - py;
      pointer.buttons = e.buttons || 0;
      if (e.type === 'pointerdown') pointer.down = true;
      if (e.type === 'pointerup' || e.type === 'pointerleave' || e.type === 'pointercancel') pointer.down = false;
    }, { passive: true });
  });
  window.getPointerState = function () { return { x: pointer.x, y: pointer.y, dx: pointer.dx, dy: pointer.dy, down: pointer.down, buttons: pointer.buttons }; };
  window.isPointerDown = function () { return !!pointer.down; };
  // 미리보기에서는 채팅으로 보내지 않는다 (티팟 미리보기와 동일). 호출되면 편집기에 알려 준다.
  window.sendToChat = function (m) { parent.postMessage({ type: 'jsx-preview:chat', message: String(m == null ? '' : m) }, '*'); };
  window.sendToReroll = function (g) { parent.postMessage({ type: 'jsx-preview:chat', message: '(다시 생성) ' + String(g == null ? '' : g) }, '*'); };
  window.getPrevUserMessage = function () { return ''; };
  window.getPrevCharMessage = function () { return ''; };
  window.__teapotSetComponent__ = function (C) { registered = C; };

  function showError(msg, force) {
    if (reactRoot && !force) { try { console.warn('[jsx-preview]', msg); } catch (e) {} parent.postMessage({ type: 'jsx-preview:warn', message: String(msg) }, '*'); return; }
    var root = document.getElementById('root');
    root.innerHTML = '';
    var d = document.createElement('div'); d.className = 'jsx-error'; d.textContent = msg || 'Unknown error'; root.appendChild(d);
    if (reactRoot) { try { reactRoot.unmount(); } catch (e) {} reactRoot = null; }
    parent.postMessage({ type: 'jsx-preview:error', message: String(msg || 'error') }, '*');
  }
  window.addEventListener('error', function (e) { showError('렌더 오류: ' + (e && e.message ? e.message : String(e))); try { e.preventDefault(); } catch (x) {} });
  window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason ? (e.reason.message || String(e.reason)) : 'unknown'; showError('비동기 오류: ' + r); try { e.preventDefault(); } catch (x) {} });

  function exposeHooks() {
    if (window.__hooks) return;
    ['useState','useEffect','useMemo','useRef','useCallback','useReducer','useContext','useLayoutEffect','useImperativeHandle','useId','useTransition','useDeferredValue','useSyncExternalStore']
      .forEach(function (n) { if (typeof React[n] === 'function') window[n] = React[n]; });
    window.__hooks = true;
  }
  function mount(Comp, props) {
    var root = document.getElementById('root');
    if (!reactRoot) { root.innerHTML = ''; reactRoot = ReactDOM.createRoot(root); }
    reactRoot.render(React.createElement(Comp, props || {}));
    parent.postMessage({ type: 'jsx-preview:ok' }, '*');
  }
  function ensureThree(code, cb) {
    if (code.indexOf('THREE') === -1 && code.indexOf('ThreeCanvas') === -1) return cb();
    if (window.THREE) { defineThreeCanvas(); return cb(); }
    var s = document.createElement('script'); s.src = '${JSX_THREE}'; s.crossOrigin = 'anonymous';
    s.onload = function () { defineThreeCanvas(); cb(); };
    s.onerror = function () { showError('Three.js load failed', true); };
    document.head.appendChild(s);
  }
  function defineThreeCanvas() {
    if (window.ThreeCanvas) return;
    window.ThreeCanvas = function (props) {
      var height = props && props.height != null ? props.height : 300, onInit = props && props.onInit, ref = React.useRef(null);
      React.useEffect(function () {
        var host = ref.current; if (!host || typeof THREE === 'undefined') return;
        var w = host.clientWidth || 300, renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(w, height); host.appendChild(renderer.domElement);
        var scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, w / height, 0.1, 1000); camera.position.z = 3;
        try { if (onInit) onInit({ THREE: THREE, scene: scene, camera: camera, renderer: renderer }); } catch (err) { showError(err && err.message ? err.message : String(err)); }
        return function () { try { renderer.dispose(); } catch (e) {} while (host.firstChild) host.removeChild(host.firstChild); };
      }, []);
      return React.createElement('div', { ref: ref, style: { width: '100%', height: height } });
    };
  }
  function run(code, name, props) {
    try {
      exposeHooks();
      if (lastComp && code === lastCode) return mount(lastComp, props);
      registered = null;
      var s = document.createElement('script'); s.textContent = code; document.body.appendChild(s); document.body.removeChild(s);
      if (!registered) { if (!reactRoot) showError('JSX 컴파일/실행 오류:\\n컴포넌트를 찾을 수 없습니다', true); return; }
      lastCode = code; lastComp = registered;
      mount(registered, props);
    } catch (e) { showError('JSX 컴파일/실행 오류:\\n' + (e && e.message ? e.message : String(e)), true); }
  }
  // 채팅 미리보기 안에 끼워 넣을 때 높이를 맞추도록 내용 높이를 알려 준다
  var lastH = -1;
  function postHeight() {
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h !== lastH) { lastH = h; parent.postMessage({ type: 'jsx-preview:height', height: h }, '*'); }
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(postHeight).observe(document.body);
  window.addEventListener('message', function (e) {
    var d = e.data; if (!d || d.type !== 'jsx-preview:init') return;
    if (d.error) return showError(d.error, true);
    ensureThree(d.compiledCode, function () { run(d.compiledCode, d.componentName, d.props); });
  });
  parent.postMessage({ type: 'jsx-preview:ready' }, '*');
})();
</script></body></html>`;
}

// ---------- 메시지 속 JSX 호출 찾기 (티팟 채팅 렌더러를 그대로 옮김) ----------
// 두 가지 형식을 지원한다: <Name prop="값" />  ·  {{jsx::Name|{"prop":"값"}}} (또는 {{jsx::<Name ... />}})
function tpScalar(s) {
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === "true" ? true : s === "false" ? false : s;
}
function tpQuoteEnd(s, i, q) {
  let a = i + 1;
  while (a < s.length) {
    const c = s[a];
    if (c === "\\") { a += 2; continue; }
    if (c === q) return a;
    a++;
  }
  return s.length - 1;
}
function tpBracketEnd(s, i) {
  const open = s[i], close = open === "[" ? "]" : "}";
  if (open !== "[" && open !== "{") return -1;
  let depth = 0, q = null;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (q) { if (c === "\\") { k++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return k;
  }
  return -1;
}
// 느슨한 JSON (작은따옴표, 따옴표 없는 키, 주석, 끝 쉼표 허용)
function tpLooseJson(e) {
  let out = "", n = 0;
  const len = e.length;
  while (n < len) {
    const r = e[n];
    if (r === '"') { const a = tpQuoteEnd(e, n, '"'); out += e.slice(n, a + 1); n = a + 1; continue; }
    if (r === "'") {
      const a = tpQuoteEnd(e, n, "'");
      out += '"' + e.slice(n + 1, a).replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"') + '"';
      n = a + 1; continue;
    }
    if (r === "/" && e[n + 1] === "/") { const t = e.indexOf("\n", n); n = t === -1 ? len : t; continue; }
    if (r === "/" && e[n + 1] === "*") { const t = e.indexOf("*/", n + 2); n = t === -1 ? len : t + 2; continue; }
    if (r === ",") {
      let k = n + 1;
      while (k < len && /\s/.test(e[k])) k++;
      if (e[k] === "}" || e[k] === "]") { n++; continue; }
      out += ","; n++; continue;
    }
    if (/[A-Za-z_$]/.test(r)) {
      let k = n;
      while (k < len && /[\w$]/.test(e[k])) k++;
      const word = e.slice(n, k);
      let i = k;
      while (i < len && /\s/.test(e[i])) i++;
      const prev = out.replace(/\s+$/, "").slice(-1);
      out += e[i] === ":" && (prev === "{" || prev === "," || prev === "") && !["true", "false", "null"].includes(word) ? `"${word}"` : word;
      n = k; continue;
    }
    out += r; n++;
  }
  return out;
}
function tpValue(e) {
  const t = e.trim();
  if (t === "") return "";
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(tpLooseJson(t)); } catch {}
  return tpScalar(t);
}
function tpTagProps(e) {
  const props = {}, re = /([A-Za-z_][\w-]*)\s*=\s*/g;
  let m;
  while ((m = re.exec(e)) !== null) {
    const key = m[1], l = re.lastIndex, c = e[l];
    if (c === '"' || c === "'") {
      let obj = null;
      const first = e[l + 1];
      if (first === "{" || first === "[") {
        const r = tpBracketEnd(e, l + 1);
        if (r !== -1) {
          let a = r + 1;
          while (a < e.length && /\s/.test(e[a])) a++;
          if (e[a] === c) { const v = tpValue(e.slice(l + 1, r + 1)); if (v !== null && typeof v === "object") obj = { value: v, next: a + 1 }; }
        }
        if (!obj) { const end = tpQuoteEnd(e, l, c), v = tpValue(e.slice(l + 1, end)); if (v !== null && typeof v === "object") obj = { value: v, next: end + 1 }; }
      }
      if (obj) { props[key] = obj.value; re.lastIndex = obj.next; }
      else { const end = tpQuoteEnd(e, l, c); props[key] = tpScalar(e.slice(l + 1, end)); re.lastIndex = end + 1; }
    } else if (c === "{") {
      const t = tpBracketEnd(e, l);
      if (t === -1) break;
      const inner = e.slice(l + 1, t);
      let v = tpValue(inner);
      if (typeof v === "string") {
        const n = inner.trim();
        if (n && !n.startsWith("{") && n.includes(":")) { const o = tpValue(`{${n}}`); if (o !== null && typeof o === "object") v = o; }
      }
      props[key] = v; re.lastIndex = t + 1;
    } else if (c === "[") {
      const t = tpBracketEnd(e, l);
      if (t === -1) break;
      props[key] = tpValue(e.slice(l, t + 1)); re.lastIndex = t + 1;
    } else if (c !== undefined && !/\s/.test(c) && c !== ">" && c !== "/") {
      let t = l;
      while (t < e.length && !/\s/.test(e[t]) && e[t] !== ">" && !(e[t] === "/" && e[t + 1] === ">")) t++;
      props[key] = tpScalar(e.slice(l, t)); re.lastIndex = t;
    }
  }
  return props;
}
// 호출 하나 → { name, props }
function parseJsxCall(inner) {
  const t = inner.trim();
  if (t.startsWith("<")) {
    const m = t.match(/^<\s*([A-Za-z_][\w]*)/);
    return m ? { name: m[1], props: tpTagProps(t) } : null;
  }
  const bar = t.indexOf("|"), name = (bar === -1 ? t : t.slice(0, bar)).trim();
  if (!name) return null;
  const rest = bar === -1 ? "" : t.slice(bar + 1).trim();
  let props = {};
  if (rest) { const v = tpValue(rest); if (v && typeof v === "object" && !Array.isArray(v)) props = v; }
  return { name, props };
}
function tpTagEnd(e, s) {
  const scan = (braces) => {
    let a = s + 1, q = null, depth = 0;
    while (a < e.length) {
      const c = e[a];
      if (q) { if (c === "\\") { a += 2; continue; } if (c === q) q = null; }
      else if (c === '"' || c === "'") q = c;
      else if (braces && c === "{") depth++;
      else if (braces && c === "}") { if (depth > 0) depth--; }
      else if (c === ">" && depth === 0) {
        let n = a - 1;
        while (n > s && /\s/.test(e[n])) n--;
        return { tagEnd: a, selfClosing: e[n] === "/" };
      }
      a++;
    }
    return { tagEnd: -1, selfClosing: false };
  };
  const a = scan(true);
  return a.tagEnd !== -1 ? a : scan(false);
}
// 메시지를 글 조각과 JSX 조각으로 나눈다. 각 조각에 원문 시작 위치(start)를 붙인다.
function splitJsx(e, names, isolateUnknown) {
  const OPEN = "{{jsx::", out = [];
  let s = 0, o = 0;
  const flush = (t) => { if (t > o) out.push({ kind: "text", value: e.slice(o, t), start: o }); };
  while (s < e.length) {
    if (e.startsWith(OPEN, s)) {
      let t = s + OPEN.length, depth = 0, end = -1, q = null;
      while (t < e.length) {
        const c = e[t];
        if (q) { if (c === "\\") { t += 2; continue; } if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === "{") depth++;
        else if (c === "}") { if (depth > 0) depth--; else if (e[t + 1] === "}") { end = t; break; } }
        t++;
      }
      if (end !== -1) {
        flush(s);
        out.push({ kind: "jsx", inner: e.slice(s + OPEN.length, end), start: s, end: end + 2 });
        o = s = end + 2;
        continue;
      }
    }
    if (e[s] === "<" && (names.size > 0 || isolateUnknown)) {
      const m = /^<\s*([A-Za-z_][\w]*)/.exec(e.slice(s, s + 80));
      if (m && (names.has(m[1]) || (isolateUnknown && /^[A-Z]/.test(m[1])))) {
        const { tagEnd, selfClosing } = tpTagEnd(e, s);
        if (tagEnd !== -1) {
          const tag = e.slice(s, tagEnd + 1);
          let next = tagEnd + 1;
          if (!selfClosing) {
            const c = e.indexOf(`</${m[1]}`, next);
            if (c !== -1) { const g = e.indexOf(">", c); if (g !== -1) next = g + 1; }
          }
          flush(s);
          out.push({ kind: "jsx", inner: tag, start: s, end: next });
          o = s = next;
          continue;
        }
      }
    }
    s++;
  }
  flush(e.length);
  return out;
}
// props 문자열 속 {{img::이름}}은 빼서 컴포넌트 아래 이미지로 보여 준다 (티팟과 같음).
// 값 전체가 이미지 하나뿐이면 그 이미지 주소로 바꿔 넘긴다.
function extractJsxImages(props, images) {
  const RE = /\{\{img(?:::|:)\s*([^}]*?)\s*\}\}/g, urls = [];
  const norm = (s) => s.normalize("NFC").trim().toLowerCase();
  const map = {};
  for (const im of images ?? []) if (im?.name && im.image) map[norm(im.name)] = im.image;
  const resolve = (n) => (/^(https?:\/\/|\/)/.test(n) ? n : map[norm(n)] ?? "");
  const walk = (v) => {
    if (typeof v === "string") {
      if (!v.includes("{{img")) return v;
      const rest = v.replace(RE, "");
      if (!rest.trim()) { const m = [...v.matchAll(RE)][0]; return resolve((m?.[1] ?? "").trim()) || v; }
      for (const m of v.matchAll(RE)) { const u = resolve((m[1] ?? "").trim()); if (u && !urls.includes(u)) urls.push(u); }
      return rest.replace(/[ \t]{2,}/g, " ").trim();
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { props: walk(props), urls };
}

// 컴파일 결과는 코드별로 한 번만 만든다
const jsxCompileCache = new Map();
function compileJsxCached(code, name) {
  const key = name + "\n" + code;
  if (!jsxCompileCache.has(key)) {
    if (jsxCompileCache.size > 50) jsxCompileCache.clear();
    const p = compileJsx(code, name);
    p.catch(() => jsxCompileCache.delete(key));
    jsxCompileCache.set(key, p);
  }
  return jsxCompileCache.get(key);
}

// ---------- 편집기 쪽 미리보기 패널 ----------
function makeJsxPreview({ record, editor }) {
  const frame = el("iframe", { class: "pv-frame jsx-frame", sandbox: "allow-scripts", title: "JSX 미리보기" });
  const status = el("div", { class: "jsx-status" });
  const bar = el("div", { class: "pv-bar" }, el("span", {}, "JSX 미리보기"), el("span", { class: "pv-tip" }, "티팟과 같은 방식으로 검증·실행합니다 · 미리보기 props는 각 prop의 예시값"));
  const reload = el("button", { class: "small ghost", title: "컴포넌트 상태를 처음부터 다시 실행" }, "다시 실행");
  bar.append(reload);
  const box = el("div", { class: "preview" }, bar, status, frame);
  let ready = false, timer = null, lastKey = null, keepStatus = false;

  const showStatus = (kind, items) => {
    status.className = "jsx-status " + kind;
    status.replaceChildren(...items);
  };
  const errorRow = (e) =>
    el("div", { class: "jsx-err-row", title: "클릭하면 해당 줄로 이동", onclick: () => editor()?.gotoLine(e.line) }, `✗ ${e.line}:${e.column} — ${e.message}`);

  async function render(force = false) {
    if (!ready) return;
    const rec = record();
    const code = String(rec.code ?? "");
    const props = jsxSampleProps(rec.props);
    const key = JSON.stringify([code, props]);
    if (!force && key === lastKey) return;
    lastKey = key;
    const v = validateJsx(code);
    if (!v.ok) {
      showStatus("bad", v.errors.map(errorRow));
      keepStatus = true; // iframe 쪽 안내가 검증 오류 목록을 덮지 않게
      frame.contentWindow?.postMessage({ type: "jsx-preview:init", error: "보안 검증을 통과하지 못해 실행하지 않았습니다." }, "*");
      return;
    }
    const name = jsxComponentName(code.trim()) ?? rec.name;
    const nameNote = rec.name && name !== rec.name ? [el("div", { class: "jsx-warn-row" }, `⚠ 이름 칸(${rec.name})과 코드의 컴포넌트 이름(${name})이 다릅니다. 티팟은 저장할 때 둘이 같아야 합니다.`)] : [];
    let compiled;
    try {
      showStatus("busy", [el("div", {}, "컴파일 중…"), ...nameNote]);
      compiled = await compileJsx(code, name);
    } catch (e) {
      const m = /\((\d+):(\d+)\)/.exec(e.message);
      // 감싼 코드 첫 줄만큼 줄 번호를 보정한다
      const line = m ? Math.max(1, Number(m[1]) - 1) : 1;
      showStatus("bad", [errorRow({ line, column: m ? Number(m[2]) : 1, message: "문법 오류: " + e.message.replace(/^\/?preview\.tsx: /, "").split("\n")[0] }), ...nameNote]);
      return;
    }
    showStatus("ok", [el("div", {}, "✓ 안전한 JSX 입니다."), ...nameNote]);
    frame.contentWindow?.postMessage({ type: "jsx-preview:init", compiledCode: compiled, componentName: name, props }, "*");
  }
  function update() {
    clearTimeout(timer);
    timer = setTimeout(() => render(false), 450);
  }
  function restart() {
    ready = false;
    lastKey = null;
    frame.srcdoc = jsxSandboxDoc();
  }

  const onMsg = (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === "jsx-preview:ready") {
      ready = true;
      render(true);
    } else if (d.type === "jsx-preview:error") {
      if (keepStatus) return void (keepStatus = false);
      showStatus("bad", [el("div", {}, "✗ " + d.message)]);
    } else if (d.type === "jsx-preview:warn") {
      status.append(el("div", { class: "jsx-warn-row" }, "⚠ 실행 중 오류: " + d.message));
    } else if (d.type === "jsx-preview:chat") {
      toast("sendToChat 호출 (미리보기라 전송하지 않음): " + d.message);
    }
  };
  window.addEventListener("message", onMsg);
  // 편집 화면이 바뀌면 리스너를 정리한다
  const obs = new MutationObserver(() => {
    if (!box.isConnected) {
      window.removeEventListener("message", onMsg);
      obs.disconnect();
    }
  });
  queueMicrotask(() => obs.observe(document.body, { childList: true, subtree: true }));

  reload.addEventListener("click", restart);
  showStatus("busy", [el("div", {}, "미리보기 준비 중…")]);
  restart();

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
