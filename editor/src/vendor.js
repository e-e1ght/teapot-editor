// 편집기용 라이브러리 묶음 (npm run build:vendor → editor/vendor.js, 전역 TPV)
//  - createEditor: CodeMirror 6 편집기 (마크다운/HTML/JS 강조, 줄 번호, 검색, 줄 이동)
//  - renderTeapot: 티팟과 같은 방식으로 마크다운+HTML을 렌더링 (요소마다 원본 줄 번호 표시)
import { EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  Decoration, ViewPlugin, MatchDecorator, placeholder as cmPlaceholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import { visit, SKIP } from "unist-util-visit";

// ---------------- CodeMirror ----------------
// 색은 style.css의 .tok-* 클래스로 (라이트/다크 대응)
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "tok-h tok-h1" },
  { tag: t.heading2, class: "tok-h tok-h2" },
  { tag: t.heading3, class: "tok-h tok-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], class: "tok-h" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.emphasis, class: "tok-em" },
  { tag: t.strikethrough, class: "tok-strike" },
  { tag: t.quote, class: "tok-quote" },
  { tag: [t.link, t.url], class: "tok-link" },
  { tag: t.monospace, class: "tok-code" },
  { tag: [t.processingInstruction, t.contentSeparator], class: "tok-mark" },
  { tag: t.comment, class: "tok-comment" },
  { tag: [t.tagName, t.angleBracket], class: "tok-tag" },
  { tag: t.attributeName, class: "tok-attr" },
  { tag: [t.attributeValue, t.string, t.special(t.string)], class: "tok-str" },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], class: "tok-kw" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "tok-num" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-fn" },
  { tag: [t.propertyName], class: "tok-prop" },
  { tag: [t.typeName, t.className], class: "tok-type" },
  { tag: [t.brace, t.bracket, t.paren, t.punctuation, t.separator], class: "tok-punct" },
]);

// {user} {char} {{img::이름}} 강조
const varMatcher = new MatchDecorator({
  regexp: /\{\{img::[^}]*\}\}|\{(?:user|char)\}/g,
  decoration: () => Decoration.mark({ class: "cm-tp-var" }),
});
const varHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = varMatcher.createDeco(view);
    }
    update(u) {
      this.decorations = varMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations }
);

// 줄 이동 시 잠깐 깜빡이는 표시
const flashEffect = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(flashEffect)) {
      if (e.value == null) deco = Decoration.none;
      else {
        const b = new RangeSetBuilder();
        for (let pos = e.value.from; pos <= e.value.to; ) {
          const line = tr.state.doc.lineAt(pos);
          b.add(line.from, line.from, Decoration.line({ class: "cm-tp-flash" }));
          pos = line.to + 1;
        }
        deco = b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function langExt(lang) {
  if (lang === "markdown") return [markdown(), syntaxHighlighting(mdHighlight)];
  if (lang === "html") return [markdown(), syntaxHighlighting(mdHighlight)]; // 티팟은 마크다운 안의 HTML로 처리
  if (lang === "js") return [javascript({ jsx: true }), syntaxHighlighting(mdHighlight)];
  return [];
}

export function createEditor({ parent, doc = "", lang = "markdown", readOnly = false, onChange, gutter = true, wrap = true, crlf = false, placeholder = "", minHeight }) {
  const exts = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    indentOnInput(),
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
    langExt(lang),
    varHighlighter,
    flashField,
    EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
  ];
  if (gutter) exts.push(lineNumbers(), highlightActiveLineGutter(), foldGutter());
  if (wrap) exts.push(EditorView.lineWrapping);
  if (crlf) exts.push(EditorState.lineSeparator.of("\r\n"));
  if (readOnly) exts.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
  if (placeholder) exts.push(cmPlaceholder(placeholder));
  if (minHeight) exts.push(EditorView.theme({ ".cm-content, .cm-gutter": { minHeight } }));
  if (onChange) exts.push(EditorView.updateListener.of((u) => u.docChanged && onChange(u.state.doc.toString())));

  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: exts }) });
  let flashTimer;
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue(v) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    // 줄(1부터)로 이동하고 잠깐 강조. endLine까지 범위 강조 가능
    gotoLine(line, endLine = line) {
      const d = view.state.doc;
      const a = d.line(Math.max(1, Math.min(d.lines, line)));
      const b = d.line(Math.max(1, Math.min(d.lines, endLine)));
      view.dispatch({
        selection: { anchor: a.from },
        effects: [EditorView.scrollIntoView(a.from, { y: "center" }), flashEffect.of({ from: a.from, to: b.from })],
      });
      view.focus();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1600);
    },
  };
}

// ---------------- 티팟 렌더링 ----------------
// 티팟 원본 규칙 (react-markdown + remark-gfm + rehype-raw + 자체 정리):
//  - 잘못된 태그 이름 → span, il → li
//  - on* 속성 제거, href/src의 javascript:/vbscript:/data:text/html 제거
//  - html/head/script/iframe/object/embed 요소 제거
//  - em은 기울임 없이 색만 다른 span, p 안에 블록 요소가 있으면 div
const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const RENAME = { il: "li" };
const BAD_URL = /^\s*(javascript|vbscript|data:text\/html)/i;
const BLOCKED = new Set(["html", "head", "script", "iframe", "object", "embed"]);
const BLOCK_CHILD = new Set(["img", "div", "pre", "blockquote", "ul", "ol", "table", "figure", "details", "hr", "p"]);

function teapotSanitize() {
  return (tree) => {
    visit(tree, "element", (node) => {
      const r = RENAME[node.tagName];
      if (r) node.tagName = r;
      if (!VALID_TAG.test(node.tagName)) node.tagName = "span";
      const p = node.properties || {};
      for (const k of Object.keys(p)) {
        if (/^on/i.test(k)) delete p[k];
        else if ((k === "href" || k === "src") && typeof p[k] === "string" && BAD_URL.test(p[k])) delete p[k];
      }
    });
    // 허용 안 되는 요소는 자식까지 통째로 제거 (react-markdown allowElement 동작)
    visit(tree, (node, index, parent) => {
      if (parent && node.type === "element" && (BLOCKED.has(node.tagName) || !VALID_TAG.test(node.tagName))) {
        parent.children.splice(index, 1);
        return [SKIP, index];
      }
    });
  };
}

function teapotComponents(opts) {
  return (tree) => {
    visit(tree, "element", (node) => {
      const p = (node.properties ||= {});
      const cls = (c) => (p.className = [...(Array.isArray(p.className) ? p.className : p.className ? [p.className] : []), c]);
      if (node.position && opts.lines) {
        p.dataSrcLine = node.position.start.line + (opts.lineOffset || 0);
        p.dataSrcEnd = node.position.end.line + (opts.lineOffset || 0);
      }
      switch (node.tagName) {
        case "em":
          node.tagName = "span";
          cls("tp-em");
          break;
        case "strong":
          cls("tp-strong");
          break;
        case "p":
          if (node.children.some((c) => c.type === "element" && BLOCK_CHILD.has(c.tagName))) node.tagName = "div";
          cls("tp-p");
          break;
        case "a":
          p.target = "_blank";
          p.rel = ["noopener", "noreferrer"];
          break;
        case "style":
          node.children = [{ type: "text", value: scopeCss(node.children.map((c) => c.value || "").join(""), opts.scope || ".tp-root") }];
          break;
      }
    });
  };
}

export function renderTeapot(src, opts = {}) {
  const file = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(teapotSanitize)
    .use(teapotComponents, { lines: true, ...opts })
    .use(rehypeStringify)
    .processSync(src);
  return String(file);
}

// 티팟의 <style> 범위 제한 함수(원본 그대로 옮김): 선택자 앞에 범위를 붙이고 @import는 버림
const ROOT_SEL = new Set(["html", "body", ":root", "html body"]);
const AT_NEST = /^@(media|supports|container|layer|scope)\b/i;
const AT_RAW = /^@(keyframes|-webkit-keyframes|-moz-keyframes|font-face|page|property|counter-style|font-feature-values|viewport)\b/i;
export function scopeCss(css, scope) {
  const src = (css ?? "").trim();
  const sc = (scope ?? "").trim();
  if (!src || !sc) return src;
  const splitSel = (e) => {
    const out = [];
    let depth = 0, q = null, cur = "";
    for (let i = 0; i < e.length; i += 1) {
      const ch = e[i];
      if (q) {
        cur += ch;
        if (ch === "\\") (cur += e[i + 1] ?? ""), (i += 1);
        else if (ch === q) q = null;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(" || ch === "[") depth += 1;
      if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  };
  const scopeOne = (sel) => {
    const n = sel.trim().replace(/\s+/g, " ");
    if (!n) return "";
    if (/^\d|^(from|to)$/i.test(n)) return n;
    if (ROOT_SEL.has(n.toLowerCase())) return sc;
    const m1 = /^(html|body)([.:[#][^\s>+~]*)$/i.exec(n);
    if (m1) return `${sc}${m1[2]}`;
    const m2 = /^(html|body|:root)(\s*[>+~]\s*|\s+)(.+)$/i.exec(n);
    if (m2 && m2[3]) {
      const comb = m2[2].trim();
      return comb ? `${sc} ${comb} ${m2[3]}` : `${sc} ${m2[3]}`;
    }
    return `${sc} ${n}`;
  };
  const walk = (text) => {
    let out = "", pre = "", i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        const end = e === -1 ? text.length : e + 2;
        out += text.slice(i, end);
        i = end;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === "\\") j += 2;
          else if (text[j] === ch) break;
          else j += 1;
        }
        pre += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (ch === ";" && pre.trim().startsWith("@")) {
        const at = pre.trim();
        if (!/^@import\b/i.test(at)) out += `${at};`;
        pre = "";
        i += 1;
        continue;
      }
      if (ch === ";") { pre = ""; i += 1; continue; }
      if (ch === "{") {
        let depth = 1, j = i + 1, q = null;
        while (j < text.length && depth > 0) {
          const c = text[j];
          if (q) { if (c === "\\") j += 1; else if (c === q) q = null; }
          else if (c === '"' || c === "'") q = c;
          else if (c === "/" && text[j + 1] === "*") { const e = text.indexOf("*/", j + 2); j = e === -1 ? text.length : e + 1; }
          else if (c === "{") depth += 1;
          else if (c === "}") depth -= 1;
          j += 1;
        }
        const body = text.slice(i + 1, depth === 0 ? j - 1 : j);
        const head = pre.trim();
        pre = "";
        i = j;
        if (!head) continue;
        if (head.startsWith("@")) {
          out += AT_RAW.test(head) ? `${head}{${body}}` : `${head}{${walk(body)}}`;
          continue;
        }
        out += `${splitSel(head).map(scopeOne).filter(Boolean).join(", ")}{${body}}`;
        continue;
      }
      pre += ch;
      i += 1;
    }
    return out;
  };
  return walk(src);
}
