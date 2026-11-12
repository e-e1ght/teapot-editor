// 한 번에 업데이트: GitHub 저장소의 최신 파일을 받아 설치 폴더에 덮어쓴다.
//  - 사용자 데이터 폴더(config, workspace, backups, assets)와 node_modules는 건드리지 않는다.
//  - 덮어쓰기 전에 바뀌는 파일을 backups/_update/<시각>_<이전 버전>/ 에 보관한다.
//  - 의존성(package.json의 dependencies)이 바뀌었을 때만 npm install을 다시 한다.
//  - git으로 받은 폴더(.git 있음)는 git pull --ff-only로 받는다.
//  - 폴더에 .no-auto-update 파일이 있으면 하지 않는다(개발용 폴더 보호).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const KEEP = new Set(["config", "workspace", "backups", "assets", "node_modules", ".git", ".mcp.json", ".no-auto-update"]);

export function updateMode(root) {
  if (fs.existsSync(path.join(root, ".no-auto-update"))) return "disabled";
  if (fs.existsSync(path.join(root, ".git"))) return "git";
  return "download";
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, shell: process.platform === "win32", windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} 실패 (코드 ${code})\n${out.slice(-1500)}`))));
  });
}

// tar.gz 풀기 (GitHub tarball: 첫 폴더 이름은 버리고, 파일만 꺼낸다)
function untar(buf) {
  const files = [];
  let off = 0, longName = null;
  const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h.subarray(345, 500));
    let name = (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    if (longName) (name = longName), (longName = null);
    if (type !== "0" && type !== "\0") continue; // 폴더·링크 등은 건너뛴다
    const rel = name.split("/").slice(1).join("/");
    if (!rel || rel.split("/").some((p) => p === ".." || p === "")) continue;
    files.push({ rel, data: Buffer.from(data) });
  }
  return files;
}

const deps = (pkg) => JSON.stringify(pkg?.dependencies ?? {});

export async function applyUpdate({ root, repo, currentVersion, log = () => {} }) {
  const mode = updateMode(root);
  if (mode === "disabled") throw new Error("이 폴더는 자동 업데이트가 꺼져 있습니다(.no-auto-update).");
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(repo ?? "");
  if (!m) throw new Error("package.json에 GitHub 저장소 주소가 없습니다.");
  const oldPkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  const oldUserscript = await fsp.readFile(path.join(root, "userscript", "teapot-agent.user.js"), "utf8").catch(() => "");

  let changed = [];
  let backupDir = null;
  if (mode === "git") {
    log("git pull");
    const g = ["-c", `safe.directory=${root.replace(/\\/g, "/")}`];
    const before = (await run("git", [...g, "rev-parse", "HEAD"], root)).trim();
    await run("git", [...g, "pull", "--ff-only"], root);
    const after = (await run("git", [...g, "rev-parse", "HEAD"], root)).trim();
    if (before !== after) changed = (await run("git", [...g, "diff", "--name-only", before, after], root)).split(/\r?\n/).filter(Boolean);
  } else {
    log("내려받는 중");
    const r = await fetch(`https://codeload.github.com/${m[1]}/tar.gz/refs/heads/main`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`내려받기 실패 (HTTP ${r.status})`);
    const files = untar(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
    if (!files.some((f) => f.rel === "package.json") || !files.some((f) => f.rel === "server/hub.js")) throw new Error("내려받은 파일이 올바르지 않습니다.");
    const todo = [];
    for (const f of files) {
      if (KEEP.has(f.rel.split("/")[0])) continue;
      const abs = path.join(root, ...f.rel.split("/"));
      if (!abs.startsWith(root + path.sep)) continue;
      const cur = await fsp.readFile(abs).catch(() => null);
      if (cur && cur.equals(f.data)) continue;
      todo.push({ ...f, abs, cur });
    }
    if (todo.length) {
      log(`파일 ${todo.length}개 교체`);
      backupDir = path.join(root, "backups", "_update", `${new Date().toISOString().replace(/[:.]/g, "-")}_v${currentVersion}`);
      for (const t of todo) {
        if (t.cur) {
          const b = path.join(backupDir, ...t.rel.split("/"));
          await fsp.mkdir(path.dirname(b), { recursive: true });
          await fsp.writeFile(b, t.cur);
        }
      }
      for (const t of todo) {
        await fsp.mkdir(path.dirname(t.abs), { recursive: true });
        await fsp.writeFile(t.abs, t.data);
      }
    }
    changed = todo.map((t) => t.rel);
  }

  const newPkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  let npm = false;
  if (deps(oldPkg) !== deps(newPkg) || !fs.existsSync(path.join(root, "node_modules"))) {
    log("npm install");
    await run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], root);
    npm = true;
  }
  const newUserscript = await fsp.readFile(path.join(root, "userscript", "teapot-agent.user.js"), "utf8").catch(() => "");
  return {
    mode,
    from: oldPkg.version,
    to: newPkg.version,
    changed,
    backup: backupDir,
    npm,
    userscriptChanged: oldUserscript !== newUserscript,
  };
}
