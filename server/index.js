#!/usr/bin/env node
// teapot-agent: Claude Code <-> 티팟 제작창 MCP 서버
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { writeSnapshotDir, readSnapshotDir, TEXT_FIELDS, START_TEXT_FIELDS } from "./files.js";
import { applyFile, fnv1a, PUT_KINDS } from "./put-file.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.resolve(process.env.TEAPOT_WORKSPACE ?? path.join(ROOT, "workspace"));
const PORT = Number(process.env.TEAPOT_BRIDGE_PORT ?? 18765);
const HUB = `http://127.0.0.1:${PORT}`;

// ---------- 허브 연결 (허브가 없으면 백그라운드로 띄운다) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hubStatus() {
  const r = await fetch(`${HUB}/api/status`, { signal: AbortSignal.timeout(1500) });
  const j = await r.json();
  if (!j.hub) throw new Error("포트를 다른 프로그램이 쓰고 있습니다");
  return j;
}

let starting = null;
async function ensureHub() {
  try {
    return await hubStatus();
  } catch {}
  starting ??= (async () => {
    spawn(process.execPath, [path.join(ROOT, "server", "hub.js")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        return await hubStatus();
      } catch {}
    }
    throw new Error(`허브(${HUB})를 시작하지 못했습니다.`);
  })().finally(() => (starting = null));
  return starting;
}

async function hubRequest(type, payload = {}) {
  await ensureHub();
  const r = await fetch(`${HUB}/api/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" },
    body: JSON.stringify({ type, source: "claude", ...payload }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "허브 오류");
  return j.result;
}

const bridge = { call: (fn, data) => hubRequest("call", { fn, data }), request: hubRequest };
ensureHub().catch((e) => console.error(`[teapot-agent] ${e.message}`));

const RULES_FILE = path.join(ROOT, ".claude", "skills", "teapot-html-jsx", "SKILL.md");
const server = new McpServer(
  { name: "teapot-agent", version: "0.2.0" },
  {
    instructions:
      "티팟(teapotchat.com) 캐릭터 제작 도구. 작업을 시작하기 전에 반드시 teapot_rules를 호출해 작업 수칙과 티팟 렌더링·보안 규칙을 읽을 것. 등록(발행)과 삭제는 하지 않는다.\n" +
      "작업 수칙 (내용 유실 방지, 매번 지킬 것):\n" +
      "(1) 반드시 서버 최신본을 확인한 뒤 작업한다. 고치기 직전에 teapot_get(또는 teapot_pull)으로 다시 읽고, 예전에 읽은 내용이나 기존 로컬 파일을 기준으로 삼지 않는다. 로컬 파일이 서버보다 오래됐으면 서버 내용을 먼저 반영한다. teapot_push가 서버 변경을 이유로 거부하면 force로 덮어쓰지 말고 다시 받아 합친다.\n" +
      "(2) 수정 사항이 있으면 로컬 파일을 통째로 덮어쓰지 않고 수정한 부분만 고친다(Write 대신 Edit). teapot_update의 patch·teapot_put_file은 칸 전체를 바꾸므로, 최신 내용에서 필요한 부분만 고친 결과를 넣고 관계없는 칸은 건드리지 않는다.",
  }
);

// ---------- helpers ----------
const text = (t) => ({ content: [{ type: "text", text: t }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const fail = (e) => ({ content: [{ type: "text", text: `오류: ${e.message ?? e}` }], isError: true });
const safe = (fn) => async (args) => {
  try {
    return await fn(args ?? {});
  } catch (e) {
    return fail(e);
  }
};

async function resolveIds({ characterId, checkpointId } = {}, { needCheckpoint = true } = {}) {
  const info = (characterId && (checkpointId || !needCheckpoint)) ? {} : ((await ensureHub()).tabs.at(-1) ?? {});
  const cid = characterId || info.cid;
  const cpid = checkpointId || info.cpid;
  if (!cid) throw new Error("characterId가 없습니다. 제작창 탭을 열거나 characterId를 지정하세요.");
  if (needCheckpoint && !cpid) throw new Error("checkpointId가 없습니다. 제작창에서 저장본을 열거나 checkpointId를 지정하세요.");
  return { cid, cpid };
}

async function fetchCheckpoint(cid, cpid) {
  const r = await bridge.call("getCheckpoint", { characterId: cid, checkpointId: cpid });
  if (!r?.checkpoint?.snapshot) throw new Error("저장본을 불러오지 못했습니다: " + JSON.stringify(r).slice(0, 300));
  return r.checkpoint;
}

const size = (v) =>
  typeof v === "string" ? `${v.length}자` : Array.isArray(v) ? `${v.length}개` : v && typeof v === "object" ? "{…}" : JSON.stringify(v);

function overview(cp) {
  const s = cp.snapshot;
  const fields = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "start_settings" || k.startsWith("creator_")) continue;
    fields[k] = v === null || typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 60) ? v : size(v);
  }
  return {
    checkpoint: { id: cp.id, name: cp.name, status: cp.cp_status, saved: tsToIso(cp.time_saved) },
    fields,
    start_settings: (s.start_settings ?? []).map((x, i) => ({
      index: i,
      setting_name: x.setting_name,
      ...Object.fromEntries(START_TEXT_FIELDS.map((f) => [f, size(x[f])])),
      recommended_answers: size(x.recommended_answers),
    })),
  };
}

function tsToIso(t) {
  return t?._seconds ? new Date(t._seconds * 1000 + Math.round((t._nanoseconds ?? 0) / 1e6)).toISOString() : null;
}

// 티팟과 같은 JSX 컴파일 캐시 처리: 코드가 바뀌었으면 compiled_ast=null, compiled_hash=FNV-1a(code)
function refreshJsxHashes(snapshot) {
  const lists = [snapshot.jsx_components, ...(snapshot.start_settings ?? []).map((s) => s?.additional_jsx_components)];
  for (const list of lists) {
    for (const j of Array.isArray(list) ? list : []) {
      if (!j || typeof j.code !== "string") continue;
      const hash = fnv1a(j.code);
      if (j.compiled_hash !== hash) {
        j.compiled_ast = null;
        j.compiled_hash = hash;
      }
    }
  }
}

async function save({ cid, cpid, snapshot, saveAsNew }) {
  refreshJsxHashes(snapshot);
  if (saveAsNew) {
    const r = await bridge.call("createCheckpoint", { characterId: cid, name: saveAsNew, snapshot });
    return { mode: "created", result: r };
  }
  const r = await bridge.call("updateCheckpoint", { characterId: cid, cpId: cpid, snapshot });
  return { mode: "updated", result: r };
}

function summarizeSave(res) {
  const cp = res.result?.checkpoint;
  return {
    mode: res.mode,
    success: res.result?.success ?? null,
    checkpoint: cp ? { id: cp.id, name: cp.name, saved: tsToIso(cp.time_saved) } : res.result,
  };
}

const EDITOR_NOTE =
  "열려 있는 티팟 제작창에는 자동 반영되지 않습니다(로컬 편집기는 자동으로 다시 불러옴). 티팟 제작창에서 그대로 '저장'을 누르면 이 변경을 덮어쓰니, 먼저 teapot_reload_editor로 새로고침하세요.";

const idArgs = {
  characterId: z.string().optional().describe("캐릭터 ID(cid). 생략하면 열려 있는 제작창 탭 기준"),
  checkpointId: z.string().optional().describe("저장본 ID(cpid). 생략하면 열려 있는 제작창 탭 기준"),
};

// ---------- tools ----------
server.registerTool(
  "teapot_status",
  {
    title: "연결 상태",
    description: "브리지 포트와 연결된 티팟 탭(현재 URL, cid, cpid, 단계)을 보여준다.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => json({ ...(await ensureHub()), editor: `${HUB}/`, workspace: WORKSPACE }))
);

server.registerTool(
  "teapot_rules",
  {
    title: "티팟 HTML·JSX 규칙",
    description:
      "작업 수칙(서버 최신본 확인 후 작업, 고칠 부분만 수정)과 티팟의 HTML·마크다운 렌더링 규칙(허용/제거되는 태그·속성, <style> 범위, 기본 스타일, 변수), JSX 컴포넌트 보안 검증 규칙·데이터 구조를 돌려준다. 작업을 시작하기 전에 먼저 읽을 것.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => text((await fs.readFile(RULES_FILE, "utf8")).replace(/^---[\s\S]*?---\s*/, "")))
);

server.registerTool(
  "teapot_list_checkpoints",
  {
    title: "저장 목록",
    description: "캐릭터의 저장본(체크포인트) 목록.",
    inputSchema: { characterId: idArgs.characterId },
    annotations: { readOnlyHint: true },
  },
  safe(async (a) => {
    const { cid } = await resolveIds(a, { needCheckpoint: false });
    const r = await bridge.call("listCheckpoints", { characterId: cid, summaryOnly: true });
    return json({
      characterId: cid,
      checkpoints: (r.checkpoints ?? []).map((c) => ({ id: c.id, name: c.name, status: c.cp_status, saved: tsToIso(c.time_saved) })),
    });
  })
);

server.registerTool(
  "teapot_overview",
  {
    title: "저장본 개요",
    description:
      "저장본의 필드 목록과 길이만 요약해서 보여준다(긴 본문 제외, 토큰 절약). 먼저 이걸로 구조를 보고 필요한 필드만 teapot_get으로 읽을 것.",
    inputSchema: idArgs,
    annotations: { readOnlyHint: true },
  },
  safe(async (a) => {
    const { cid, cpid } = await resolveIds(a);
    return json({ characterId: cid, ...overview(await fetchCheckpoint(cid, cpid)) });
  })
);

server.registerTool(
  "teapot_get",
  {
    title: "필드 읽기",
    description:
      `저장본에서 지정한 최상위 필드만 읽는다. 예: ["prompt","worldview"], ["keyword_books"], ["start_settings"]. 주요 텍스트 필드: ${TEXT_FIELDS.join(", ")}.`,
    inputSchema: {
      ...idArgs,
      fields: z.array(z.string()).min(1).describe("읽을 최상위 필드 이름들"),
      start_index: z.number().int().optional().describe("start_settings를 읽을 때 특정 인덱스만"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async (a) => {
    const { cid, cpid } = await resolveIds(a);
    const s = (await fetchCheckpoint(cid, cpid)).snapshot;
    const out = {};
    for (const f of a.fields) {
      if (f === "start_settings" && a.start_index != null) out[f] = { [a.start_index]: s.start_settings?.[a.start_index] };
      else out[f] = s[f];
    }
    return json(out);
  })
);

server.registerTool(
  "teapot_update",
  {
    title: "필드 수정 후 저장",
    description:
      "서버의 최신 저장본을 받아 patch(최상위 필드 덮어쓰기)와 start_patches(시작 상황 인덱스별 부분 수정)를 합친 뒤 저장한다. 저장 전 원본은 backups/에 자동 백업된다. save_as_new를 주면 기존 저장본은 그대로 두고 새 저장본을 만든다. 심사 중·등록 완료(cp_status가 ACCEPTED 등) 저장본은 티팟이 덮어쓰기를 막으므로 save_as_new를 써야 한다. 등록(발행)은 하지 않는다. prompt_char_count는 건드리지 말 것. " +
      "patch에 넣은 칸은 통째로 바뀌므로, 직전에 teapot_get으로 최신 내용을 읽고 고칠 부분만 고친 결과를 넣을 것. 바꿀 필요가 없는 칸은 넣지 않는다.",
    inputSchema: {
      ...idArgs,
      patch: z.record(z.any()).optional().describe('최상위 필드 덮어쓰기. 예: {"oneline_description":"...", "worldview":"..."}'),
      start_patches: z
        .array(z.object({ index: z.number().int(), fields: z.record(z.any()) }))
        .optional()
        .describe("start_settings[index]에 fields를 합친다. index가 길이와 같으면 새 시작 상황을 추가"),
      save_as_new: z.string().optional().describe("새 저장본 이름. 지정하면 새 저장본으로 저장"),
    },
  },
  safe(async (a) => {
    if (!a.patch && !a.start_patches) throw new Error("patch 또는 start_patches가 필요합니다.");
    const { cid, cpid } = await resolveIds(a);
    const cp = await fetchCheckpoint(cid, cpid);
    const snapshot = { ...cp.snapshot, ...(a.patch ?? {}) };
    if (a.start_patches) {
      const starts = [...(snapshot.start_settings ?? [])];
      for (const { index, fields } of a.start_patches) {
        if (index > starts.length) throw new Error(`start_settings 인덱스 ${index}가 범위를 벗어났습니다 (현재 ${starts.length}개).`);
        const base = starts[index] ?? Object.fromEntries(Object.keys(starts[0] ?? {}).map((k) => [k, Array.isArray(starts[0][k]) ? [] : ""]));
        starts[index] = { ...base, ...fields };
      }
      snapshot.start_settings = starts;
    }
    const res = await save({ cid, cpid, snapshot, saveAsNew: a.save_as_new });
    return json({ ...summarizeSave(res), backup: res.result?._backup ?? null, note: EDITOR_NOTE });
  })
);

server.registerTool(
  "teapot_pull",
  {
    title: "로컬로 내려받기",
    description:
      "저장본을 로컬 폴더로 내려받는다. 긴 텍스트는 .md 파일(prompt.md, worldview.md, start_settings/01/start_message.md …), 나머지는 _meta.json. 파일을 편집한 뒤 teapot_push로 올린다. 기존 폴더 내용은 서버 내용으로 덮어쓰므로, 아직 올리지 않은 로컬 수정이 있으면 먼저 올리거나 보관할 것. 받은 파일을 고칠 때는 통째로 다시 쓰지 말고 고칠 부분만 Edit으로 바꿀 것.",
    inputSchema: { ...idArgs, dir: z.string().optional().describe("내려받을 폴더. 기본: workspace/<characterId>") },
  },
  safe(async (a) => {
    const { cid, cpid } = await resolveIds(a);
    const cp = await fetchCheckpoint(cid, cpid);
    const dir = path.resolve(a.dir ?? path.join(WORKSPACE, cid));
    await writeSnapshotDir(dir, cp.snapshot, {
      characterId: cid,
      checkpointId: cpid,
      checkpointName: cp.name,
      timeSaved: tsToIso(cp.time_saved),
      pulledAt: new Date().toISOString(),
    });
    return json({ dir, checkpoint: cp.name, ...overview(cp) });
  })
);

server.registerTool(
  "teapot_push",
  {
    title: "로컬에서 올리기",
    description:
      "teapot_pull로 받은 폴더를 다시 합쳐 저장한다. 내려받은 뒤 서버 저장본이 바뀌었으면 force 없이는 거부한다. 거부되면 force로 덮어쓰지 말고, 서버의 바뀐 내용을 로컬에 합친 뒤 올릴 것(force는 사용자가 서버 쪽 변경을 버려도 된다고 할 때만). 저장 전 서버 원본은 backups/에 백업된다.",
    inputSchema: {
      dir: z.string().optional().describe("올릴 폴더. 기본: 연결된 탭 cid 기준 workspace/<characterId>"),
      save_as_new: z.string().optional().describe("새 저장본 이름. 지정하면 새 저장본으로 저장"),
      force: z.boolean().optional().describe("서버 쪽 변경을 무시하고 덮어쓰기"),
    },
  },
  safe(async (a) => {
    const dir = path.resolve(a.dir ?? path.join(WORKSPACE, (await resolveIds({}, { needCheckpoint: false })).cid));
    const { state, snapshot } = await readSnapshotDir(dir);
    const cid = state.characterId;
    const cpid = state.checkpointId;
    const latest = await fetchCheckpoint(cid, cpid);
    const latestSaved = tsToIso(latest.time_saved);
    if (!a.save_as_new && !a.force && latestSaved !== state.timeSaved) {
      throw new Error(
        `내려받은 뒤(${state.timeSaved}) 서버 저장본이 바뀌었습니다(${latestSaved}). 다시 pull 하거나, save_as_new로 따로 저장하거나, force: true로 덮어쓰세요.`
      );
    }
    const res = await save({ cid, cpid, snapshot, saveAsNew: a.save_as_new });
    const out = summarizeSave(res);
    // 저장은 이미 끝났다. 로컬 폴더 갱신이 실패해도 저장 실패로 알리지 않는다(같은 내용을 두 번 저장하지 않도록).
    let localNote = null;
    if (res.mode === "updated") {
      try {
        const after = await fetchCheckpoint(cid, cpid);
        const left = await writeSnapshotDir(dir, after.snapshot, { ...state, timeSaved: tsToIso(after.time_saved), pulledAt: new Date().toISOString() });
        if (left.length) localNote = `저장 완료. 줄어든 시작 상황 폴더 일부를 지우지 못했습니다(다른 프로그램이 사용 중): ${left.join(", ")}`;
      } catch (e) {
        localNote = `저장은 완료됐습니다. 다만 로컬 폴더를 최신 상태로 갱신하지 못했습니다(${e.code ?? e.message}). 다시 저장하지 말고, 다음 수정 전에 teapot_pull로 다시 받으세요.`;
      }
    }
    return json({ ...out, backup: res.result?._backup ?? null, ...(localNote ? { local: localNote } : {}), note: EDITOR_NOTE });
  })
);

server.registerTool(
  "teapot_put_file",
  {
    title: "파일 내용으로 칸 채우기",
    description:
      "로컬 파일 내용을 저장본의 한 칸에 그대로 넣고 저장한다. 서버가 파일을 직접 읽으므로 긴 JSX 코드·HTML·프롬프트를 대화로 옮겨 적을 필요가 없다(오타 방지). " +
      "JSX는 티팟 보안 검증을 통과해야 저장되며 compiled_hash도 자동 갱신된다. 같은 폴더의 <이름>.meta.json이 있으면 JSX의 표시 이름·설명·props도 맞춘다. " +
      "dry_run이면 저장하지 않고 바뀔 내용(글자 수)만 알려 준다. " +
      "칸 전체가 파일 내용으로 바뀌므로, 파일은 서버 최신본(teapot_get으로 확인)에서 출발해 고칠 부분만 Edit으로 고친 것이어야 한다. 글자 수가 예상보다 크게 줄면 저장하지 말고 확인할 것. kind: " +
      Object.entries(PUT_KINDS).map(([k, v]) => `${k} = ${v}`).join(" / "),
    inputSchema: {
      ...idArgs,
      file: z.string().describe("넣을 파일 경로 (절대 경로 권장)"),
      kind: z.enum(Object.keys(PUT_KINDS)).describe("어느 칸에 넣을지"),
      name: z.string().optional().describe("JSX 이름 / 가이드라인 제목·#번호 / 시작 상황 이름·#번호"),
      field: z.string().optional().describe("kind가 field 또는 start_addition일 때 칸 이름"),
      dry_run: z.boolean().optional().describe("true면 저장하지 않고 결과만 미리 본다"),
      save_as_new: z.string().optional().describe("새 저장본 이름. 심사 중·등록 완료 저장본이면 이걸 써야 한다"),
    },
  },
  safe(async (a) => {
    const { cid, cpid } = await resolveIds(a);
    const cp = await fetchCheckpoint(cid, cpid);
    const snapshot = cp.snapshot;
    const r = await applyFile(snapshot, { file: a.file, kind: a.kind, name: a.name, field: a.field });
    const base = { ...r, checkpoint: cp.name };
    if (!r.changed) return json({ ...base, saved: false, note: "파일 내용이 저장본과 같아 저장하지 않았습니다." });
    if (a.dry_run) return json({ ...base, saved: false, note: "dry_run: 저장하지 않았습니다." });
    const res = await save({ cid, cpid, snapshot, saveAsNew: a.save_as_new });
    return json({ ...base, saved: true, ...summarizeSave(res), backup: res.result?._backup ?? null, note: EDITOR_NOTE });
  })
);

server.registerTool(
  "teapot_reload_editor",
  {
    title: "제작창 새로고침",
    description: "연결된 티팟 탭을 새로고침해 서버 저장본을 다시 불러오게 한다. checkpointId를 주면 그 저장본으로 이동.",
    inputSchema: { checkpointId: z.string().optional() },
  },
  safe(async (a) => {
    const r = await bridge.request("reload", { cpid: a.checkpointId ?? null });
    return json(r);
  })
);

await server.connect(new StdioServerTransport());
console.error(`[teapot-agent] 실행됨. 브리지 ws://127.0.0.1:${PORT}`);
