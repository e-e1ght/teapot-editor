// 스냅샷 <-> 로컬 폴더 변환. 긴 텍스트는 .md 파일로 빼서 편집하기 쉽게 만든다.
import fs from "node:fs/promises";
import path from "node:path";

export const TEXT_FIELDS = [
  "prompt",
  "worldview",
  "secret",
  "output_format_prompt",
  "recommended_answer_prompt",
  "detail_description",
];

export const START_TEXT_FIELDS = [
  "start_message",
  "start_circumstance",
  "additional_prompt",
  "additional_worldview",
  "additional_secret",
  "additional_output_format",
];

const META = "_meta.json";
// _meta.json 안에서 "@file:prompt.md" 처럼 표시된 값은 그 파일 내용으로 채운다 (필드 순서 유지용).
const FILE_MARK = "@file:";

async function resolveMarks(dir, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.startsWith(FILE_MARK) && !v.endsWith("/")) {
      out[k] = (await readText(path.join(dir, v.slice(FILE_MARK.length)))) ?? "";
    } else out[k] = v;
  }
  return out;
}
const STATE = ".teapot.json";
const pad = (n) => String(n + 1).padStart(2, "0");

// Windows에서는 다른 프로그램(탐색기, 편집기, 다른 Claude 세션, 백신)이 파일을 잠깐 잡고 있으면
// EPERM/EBUSY/EACCES가 난다. 잠깐 기다렸다가 몇 번 다시 시도한다.
const LOCK_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
async function retry(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!LOCK_CODES.has(e.code) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}

async function writeText(file, text) {
  // 줄바꿈(CRLF / LF)은 원래 모양 그대로 둔다
  await retry(() => fs.writeFile(file, text ?? "", "utf8"));
}
const writeJsonFile = (file, data) => retry(() => fs.writeFile(file, JSON.stringify(data, null, 2), "utf8"));

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

// 폴더를 통째로 지우고 다시 만들지 않는다 (Windows에서 지운 직전 폴더를 다시 만들면 EPERM이 나기 쉽다).
// 파일을 제자리에서 덮어쓰고, 줄어든 시작 상황 폴더만 정리한다. 반환값: 정리하지 못한 경로 목록
export async function writeSnapshotDir(dir, snapshot, state) {
  await retry(() => fs.mkdir(dir, { recursive: true }));

  const meta = { ...snapshot };
  for (const f of TEXT_FIELDS) {
    await writeText(path.join(dir, `${f}.md`), snapshot[f]);
    meta[f] = `${FILE_MARK}${f}.md`;
  }

  const starts = snapshot.start_settings ?? [];
  meta.start_settings = starts.map((_, i) => `${FILE_MARK}start_settings/${pad(i)}/`);
  for (let i = 0; i < starts.length; i++) {
    const sdir = path.join(dir, "start_settings", pad(i));
    await retry(() => fs.mkdir(sdir, { recursive: true }));
    const smeta = { ...starts[i] };
    for (const f of START_TEXT_FIELDS) {
      await writeText(path.join(sdir, `${f}.md`), starts[i][f]);
      smeta[f] = `${FILE_MARK}${f}.md`;
    }
    await writeJsonFile(path.join(sdir, META), smeta);
  }

  // 서버에서 시작 상황이 줄었으면 남은 폴더를 정리한다 (실패해도 저장에는 영향 없음)
  const leftovers = [];
  const sroot = path.join(dir, "start_settings");
  const keep = new Set(starts.map((_, i) => pad(i)));
  for (const ent of await fs.readdir(sroot, { withFileTypes: true }).catch(() => [])) {
    if (!ent.isDirectory() || keep.has(ent.name) || !/^\d+$/.test(ent.name)) continue;
    try {
      await retry(() => fs.rm(path.join(sroot, ent.name), { recursive: true, force: true }));
    } catch {
      leftovers.push(path.join(sroot, ent.name));
    }
  }

  await writeJsonFile(path.join(dir, META), meta);
  await writeJsonFile(path.join(dir, STATE), state);
  return leftovers;
}

export async function readSnapshotDir(dir) {
  const state = await readJson(path.join(dir, STATE));
  const snapshot = await resolveMarks(dir, await readJson(path.join(dir, META)));

  const sroot = path.join(dir, "start_settings");
  let names = [];
  try {
    names = (await fs.readdir(sroot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  snapshot.start_settings = [];
  for (const name of names) {
    const sdir = path.join(sroot, name);
    snapshot.start_settings.push(await resolveMarks(sdir, await readJson(path.join(sdir, META))));
  }
  return { state, snapshot };
}

export async function backup(backupRoot, characterId, checkpointId, checkpoint) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(backupRoot, characterId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp}_${checkpointId}.json`);
  await fs.writeFile(file, JSON.stringify(checkpoint, null, 2), "utf8");
  return file;
}
