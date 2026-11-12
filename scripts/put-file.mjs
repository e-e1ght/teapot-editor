// 로컬 파일 내용을 열려 있는 티팟 저장본의 한 칸에 넣고 저장한다 (허브를 거치므로 저장 전 자동 백업).
//
// 사용법:
//   npm run put -- <파일> <kind> [name] [--field <칸>] [--dry-run] [--new <새 저장본 이름>]
//
// 예:
//   npm run put -- jsx/StatusBoard.jsx jsx                  (파일 이름 = 컴포넌트 이름)
//   npm run put -- guide.html guideline "#1"                (첫 번째 가이드라인 내용)
//   npm run put -- opening.md start_message "#2"            (두 번째 시작 상황의 시작 메시지)
//   npm run put -- world_add.md start_addition "#1" --field worldview
//   npm run put -- base.md field --field prompt --dry-run
//
// kind: jsx, guideline, start_message, start_circumstance, start_addition, field, status_template, status_constraint
import { applyFile, PUT_KINDS } from "../server/put-file.js";

const PORT = Number(process.env.TEAPOT_BRIDGE_PORT ?? 18765);
const HUB = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const dryRun = has("--dry-run");
const field = opt("--field");
const saveAsNew = opt("--new");
const [file, kind, name] = args;
if (!file || !kind) {
  console.error("사용법: npm run put -- <파일> <kind> [name] [--field <칸>] [--dry-run] [--new <새 저장본 이름>]");
  console.error("kind:\n" + Object.entries(PUT_KINDS).map(([k, v]) => `  ${k.padEnd(18)} ${v}`).join("\n"));
  process.exit(1);
}

async function call(fn, data) {
  const r = await fetch(`${HUB}/api/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" },
    body: JSON.stringify({ type: "call", source: "claude", fn, data }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error ?? "허브 오류");
  return j.result;
}

try {
  const status = await fetch(`${HUB}/api/status`).then((r) => r.json(), () => null);
  if (!status?.hub) throw new Error(`허브(${HUB})가 실행 중이 아닙니다. start-editor.bat 또는 npm run hub로 실행하세요.`);
  const tab = status.tabs.at(-1);
  if (!tab?.cid || !tab?.cpid) throw new Error("열려 있는 티팟 제작창 탭이 없습니다.");
  const cp = (await call("getCheckpoint", { characterId: tab.cid, checkpointId: tab.cpid })).checkpoint;
  const snapshot = cp.snapshot;
  const r = await applyFile(snapshot, { file, kind, name, field });
  for (const w of r.warnings) console.warn("⚠ " + w);
  const head = `${r.target}: ${r.beforeChars.toLocaleString()}자 → ${r.afterChars.toLocaleString()}자${r.created ? " (새로 만듦)" : ""}`;
  if (!r.changed) console.log(`${head} — 내용이 같아 저장하지 않았습니다.`);
  else if (dryRun) console.log(`${head} — dry-run이라 저장하지 않았습니다. (저장본: ${cp.name})`);
  else {
    const res = saveAsNew
      ? await call("createCheckpoint", { characterId: tab.cid, name: saveAsNew, snapshot })
      : await call("updateCheckpoint", { characterId: tab.cid, cpId: tab.cpid, snapshot });
    console.log(`${head} — 저장했습니다. (저장본: ${saveAsNew ?? cp.name}${res?._backup ? `, 백업: ${res._backup}` : ""})`);
    console.log("열려 있는 티팟 제작창은 새로고침해야 반영됩니다.");
  }
} catch (e) {
  console.error("오류: " + (e.message ?? e));
  process.exit(1);
}
