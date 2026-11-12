// 로컬 파일 내용을 저장본의 한 칸에 그대로 넣는다 (긴 코드·글을 손으로 옮겨 붙이다 생기는 오타 방지).
// MCP 도구(teapot_put_file)와 명령줄 스크립트(scripts/put-file.mjs)가 함께 쓴다.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const PUT_KINDS = {
  jsx: "JSX 컴포넌트 코드 (name: 컴포넌트 이름, 생략하면 파일 이름)",
  guideline: "캐릭터 가이드라인 내용 (name: 제목 또는 #번호, 없는 제목이면 새로 만든다)",
  start_message: "시작 메시지 (name: 시작 상황 이름 또는 #번호)",
  start_circumstance: "시작 상황 설명 (name: 시작 상황 이름 또는 #번호)",
  start_addition: "공용 프롬프트에 더하기 (name: 시작 상황, field: prompt|worldview|secret|output_format)",
  field: "공용 프롬프트 칸 (field: prompt|worldview|secret|output_format_prompt|recommended_answer_prompt|detail_description)",
  status_template: "상태창 템플릿 (simulation_status.status_description)",
  status_constraint: "상태창 변수 제어 프롬프트 (simulation_status.status_variable_constraint)",
};
const TOP_FIELDS = ["prompt", "worldview", "secret", "output_format_prompt", "recommended_answer_prompt", "detail_description"];
const ADD_FIELDS = { prompt: "additional_prompt", worldview: "additional_worldview", secret: "additional_secret", output_format: "additional_output_format" };
const LIMITS = { start_message: 3000, start_circumstance: 500, start_addition: 100000, jsx: 200000 };

export function fnv1a(s) {
  let t = 0x811c9dc5;
  for (let n = 0; n < s.length; n++) (t ^= s.charCodeAt(n)), (t = Math.imul(t, 0x1000193));
  return (t >>> 0).toString(16);
}

// 티팟 JSX 저장 전 보안 검증 (편집기 미리보기와 같은 규칙)
function pos(code, idx) {
  let line = 1, last = -1;
  for (let i = 0; i < idx; i++) if (code.charCodeAt(i) === 10) (line++, (last = i));
  return `${line}:${idx - last}`;
}
export function jsxName(code) {
  const a = /function\s+([A-Z][A-Za-z0-9]*)\s*\(/.exec(code), b = /(?:const|let|var)\s+([A-Z][A-Za-z0-9]*)\s*(?::[^=]*?)?=\s*(?:async\s+)?\(/.exec(code);
  const m = a && b ? (a.index <= b.index ? a : b) : a ?? b;
  return m ? m[1] : null;
}
export function checkJsx(code) {
  const errs = [];
  if (!code.trim()) return ["코드가 비어 있습니다."];
  const ie = /(?:^|\n)[ \t]*(import|export)\b/.exec(code);
  if (ie) return [`${pos(code, ie.index + ie[0].indexOf(ie[1]))} '${ie[1]}' 문은 사용할 수 없습니다.`];
  if (!jsxName(code.trim())) return ["function PascalCase(...) 또는 const PascalCase = (...) => 형식의 함수 컴포넌트가 아닙니다."];
  for (const tag of ["script", "iframe", "embed", "object", "link", "meta", "base"])
    for (const m of code.matchAll(new RegExp(`<\\s*${tag}(\\s|>|/)`, "gi"))) errs.push(`${pos(code, m.index)} 허용되지 않은 태그 <${tag}>`);
  for (const at of ["dangerouslySetInnerHTML", "srcDoc", "srcdoc", "formAction", "formaction"])
    for (const m of code.matchAll(new RegExp(`\\b${at}\\s*=`, "g"))) errs.push(`${pos(code, m.index)} 허용되지 않은 속성 ${at}`);
  for (const [re, label] of [
    [/\bwindow\s*\.\s*(parent|top|opener|frames)\b/g, "window.parent/top/opener 접근"],
    [/\bparent\s*\.\s*postMessage\b/g, "parent.postMessage 호출"],
    [/\beval\s*\(/g, "eval 호출"],
    [/\bnew\s+Function\s*\(/g, "new Function 생성"],
  ])
    for (const m of code.matchAll(re)) errs.push(`${pos(code, m.index)} 보안상 차단된 패턴: ${label}`);
  return errs;
}

function findStart(snap, name) {
  const list = snap.start_settings ?? [];
  if (!name) {
    if (list.length === 1) return list[0];
    throw new Error(`시작 상황이 ${list.length}개입니다. name에 이름이나 #번호를 지정하세요: ${list.map((s, i) => `#${i + 1} ${s.setting_name}`).join(", ")}`);
  }
  const m = /^#(\d+)$/.exec(name.trim());
  const st = m ? list[Number(m[1]) - 1] : list.find((s) => s.setting_name === name);
  if (!st) throw new Error(`시작 상황 "${name}"을(를) 찾지 못했습니다: ${list.map((s, i) => `#${i + 1} ${s.setting_name}`).join(", ")}`);
  return st;
}

/**
 * 파일을 읽어 스냅샷의 해당 칸에 넣는다. 스냅샷을 직접 바꾸고 결과 요약을 돌려준다.
 * 내용 자체는 돌려주지 않는다(글자 수·변경 여부만).
 */
export async function applyFile(snap, { file, kind, name, field }) {
  if (!PUT_KINDS[kind]) throw new Error(`kind는 ${Object.keys(PUT_KINDS).join(", ")} 중 하나여야 합니다.`);
  const abs = path.resolve(file);
  // 끝의 빈 줄·공백만 정리한다 (편집기가 붙이는 마지막 줄바꿈). 앞쪽과 본문은 그대로.
  const text = (await fs.readFile(abs, "utf8")).replace(/^﻿/, "").replace(/\s+$/, "");
  const warnings = [];
  let target, before, created = false;

  if (kind === "jsx") {
    const compName = name || path.basename(abs).replace(/\.(jsx|tsx|js|ts)$/i, "");
    const errs = checkJsx(text);
    if (errs.length) throw new Error(`티팟 JSX 보안 검증에 걸려 저장하지 않았습니다:\n- ${errs.join("\n- ")}`);
    const codeName = jsxName(text.trim());
    if (codeName !== compName) warnings.push(`코드 안의 컴포넌트 이름(${codeName})과 대상 이름(${compName})이 다릅니다. 티팟은 둘이 같아야 저장됩니다.`);
    snap.jsx_components ??= [];
    let comp = snap.jsx_components.find((c) => c.name === compName);
    // 같은 폴더의 <이름>.meta.json이 있으면 표시 이름·설명·props 등을 그 내용으로 맞춘다
    const metaPath = path.join(path.dirname(abs), `${compName}.meta.json`);
    const meta = await fs.readFile(metaPath, "utf8").then(JSON.parse, () => null);
    if (!comp) {
      if (!meta) throw new Error(`저장본에 JSX "${compName}"이(가) 없습니다. 새로 만들려면 ${metaPath} (display_name, description, trigger, props)를 준비하세요.`);
      comp = { id: crypto.randomUUID(), name: compName, display_name: "", description: "", enabled: true, is_creator: false, trigger: "always", keys: [], props: [], code: "", ...meta };
      snap.jsx_components.push(comp);
      created = true;
    } else if (meta) {
      for (const [k, v] of Object.entries(meta)) if (k !== "code" && k !== "name") comp[k] = v;
    }
    before = comp.code ?? "";
    if (before !== text) {
      comp.code = text;
      comp.compiled_ast = null;
      comp.compiled_hash = fnv1a(text);
    }
    target = `JSX ${compName}`;
  } else if (kind === "guideline") {
    snap.guidelines ??= [];
    const m = name && /^#(\d+)$/.exec(name.trim());
    let g = m ? snap.guidelines[Number(m[1]) - 1] : name ? snap.guidelines.find((x) => x.title === name) : snap.guidelines.length === 1 ? snap.guidelines[0] : null;
    if (!g) {
      if (!name || m) throw new Error(`가이드라인을 지정하세요(제목 또는 #번호): ${snap.guidelines.map((x, i) => `#${i + 1} ${x.title}`).join(", ") || "없음"}`);
      g = { title: name, content: "" };
      snap.guidelines.push(g);
      created = true;
    }
    before = g.content ?? "";
    g.content = text;
    target = `가이드라인 ${g.title}`;
  } else if (kind === "start_message" || kind === "start_circumstance") {
    const st = findStart(snap, name);
    before = st[kind] ?? "";
    st[kind] = text;
    target = `${st.setting_name} › ${kind === "start_message" ? "시작 메시지" : "시작 상황 설명"}`;
  } else if (kind === "start_addition") {
    const key = ADD_FIELDS[field];
    if (!key) throw new Error(`field는 ${Object.keys(ADD_FIELDS).join(", ")} 중 하나여야 합니다.`);
    const st = findStart(snap, name);
    before = st[key] ?? "";
    st[key] = text;
    target = `${st.setting_name} › ${field} +`;
  } else if (kind === "field") {
    if (!TOP_FIELDS.includes(field)) throw new Error(`field는 ${TOP_FIELDS.join(", ")} 중 하나여야 합니다.`);
    before = snap[field] ?? "";
    snap[field] = text;
    target = `공용 › ${field}`;
  } else {
    const key = kind === "status_template" ? "status_description" : "status_variable_constraint";
    snap.simulation_status ??= { status_description: "", status_variable_constraint: "" };
    before = snap.simulation_status[key] ?? "";
    snap.simulation_status[key] = text;
    target = `상태창 › ${kind === "status_template" ? "템플릿" : "변수 제어 프롬프트"}`;
  }

  if (LIMITS[kind] && text.length > LIMITS[kind]) warnings.push(`${target}: ${text.length.toLocaleString()}자로 티팟 제한(${LIMITS[kind].toLocaleString()}자)을 넘습니다.`);
  return { target, file: abs, created, changed: created || before !== text, beforeChars: before.length, afterChars: text.length, warnings };
}
