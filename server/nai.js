// 에셋 스튜디오: NovelAI 이미지 생성, 결과 저장, 프롬프트 보관함
//  - API 키와 설정은 config/settings.json, 프롬프트 보관함은 config/prompts.json에 저장한다 (배포본에 포함하지 않음)
//  - 생성한 이미지는 assets/<폴더>/<날짜>/ 에 PNG + 같은 이름의 JSON(생성 정보)으로 저장한다
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const IMAGE_BASE = process.env.NAI_IMAGE_BASE ?? "https://image.novelai.net";
// 구독(Anlas·생성 한도) 정보는 NovelAI 웹과 같이 이미지 서버에서 조회한다
const API_BASE = process.env.NAI_API_BASE ?? "https://image.novelai.net";

export function createNai(root) {
  const CONFIG_DIR = process.env.TEAPOT_CONFIG_DIR ?? path.join(root, "config");
  const SETTINGS = path.join(CONFIG_DIR, "settings.json");
  const PROMPTS = path.join(CONFIG_DIR, "prompts.json");
  let current = null; // 진행 중인 생성 { controller }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return fallback;
    }
  }
  async function writeJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  async function settings() {
    const s = await readJson(SETTINGS, {});
    return { apiKey: s.apiKey ?? "", assetsDir: s.assetsDir || path.join(root, "assets"), stream: s.stream !== false };
  }
  async function publicSettings() {
    const s = await settings();
    return {
      hasKey: !!s.apiKey,
      keyHint: s.apiKey ? `${s.apiKey.slice(0, 4)}…${s.apiKey.slice(-4)}` : "",
      assetsDir: s.assetsDir,
      stream: s.stream,
    };
  }
  async function saveSettings(patch) {
    const cur = await readJson(SETTINGS, {});
    if (typeof patch.apiKey === "string") cur.apiKey = patch.apiKey.trim();
    if (typeof patch.assetsDir === "string") cur.assetsDir = patch.assetsDir.trim();
    if (typeof patch.stream === "boolean") cur.stream = patch.stream;
    await writeJson(SETTINGS, cur);
    return publicSettings();
  }

  // ---------- 요청 만들기 ----------
  function buildBody(req) {
    const model = req.model || "nai-diffusion-4-5-full";
    const isV4 = /nai-diffusion-[45]/.test(model); // V4 이상은 캐릭터 프롬프트(v4_prompt) 형식
    const chars = (req.characters ?? []).filter((c) => c.enabled !== false && (c.prompt || "").trim());
    const useCoords = !!req.useCoords && chars.length > 0;
    const seed = Number.isFinite(req.seed) && req.seed > 0 ? Math.floor(req.seed) : Math.floor(Math.random() * 4294967295);
    const center = (c) => ({ x: Number(c.x ?? 0.5), y: Number(c.y ?? 0.5) });
    const parameters = {
      params_version: 3,
      width: req.width ?? 832,
      height: req.height ?? 1216,
      scale: req.scale ?? 5,
      sampler: req.sampler || "k_euler_ancestral",
      steps: req.steps ?? 28,
      n_samples: 1,
      ucPreset: req.ucPreset ?? 0,
      qualityToggle: !!req.qualityToggle,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      cfg_rescale: req.cfgRescale ?? 0,
      noise_schedule: req.noiseSchedule || "karras",
      legacy_v3_extend: false,
      skip_cfg_above_sigma: null,
      seed,
      negative_prompt: req.negative ?? "",
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
    };
    if (isV4) {
      Object.assign(parameters, {
        use_coords: useCoords,
        legacy_uc: false,
        normalize_reference_strength_multiple: true,
        characterPrompts: chars.map((c) => ({ prompt: c.prompt, uc: c.uc ?? "", center: center(c), enabled: true })),
        v4_prompt: {
          caption: { base_caption: req.prompt ?? "", char_captions: chars.map((c) => ({ char_caption: c.prompt, centers: [center(c)] })) },
          use_coords: useCoords,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: { base_caption: req.negative ?? "", char_captions: chars.map((c) => ({ char_caption: c.uc ?? "", centers: [center(c)] })) },
          legacy_uc: false,
        },
      });
    }
    return { body: { input: req.prompt ?? "", model, action: "generate", parameters }, seed };
  }

  // ---------- zip 풀기 (스트리밍을 끈 경우 응답이 zip) ----------
  function firstFileFromZip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("zip 형식이 아닙니다");
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("zip 목록을 읽지 못했습니다");
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const localOff = buf.readUInt32LE(cdOffset + 42);
    const nameLen = buf.readUInt16LE(localOff + 26);
    const extraLen = buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(localOff + 30 + nameLen + extraLen, localOff + 30 + nameLen + extraLen + compSize);
    return method === 8 ? zlib.inflateRawSync(data) : data;
  }

  // ---------- 저장 ----------
  const safeName = (s) => String(s ?? "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
  async function saveImage(png, meta, folder) {
    const s = await settings();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const stamp = `${day.replace(/-/g, "")}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dir = path.join(s.assetsDir, ...(safeName(folder) ? [safeName(folder)] : []), day);
    await fs.mkdir(dir, { recursive: true });
    // 생성 정보는 NovelAI가 PNG 안에 넣어 주므로 PNG만 저장한다
    let base = `${stamp}_${meta.seed}`;
    for (let n = 2; await fs.stat(path.join(dir, base + ".png")).then(() => true, () => false); n++) base = `${stamp}_${meta.seed}_${n}`;
    await fs.writeFile(path.join(dir, base + ".png"), png);
    return path.relative(s.assetsDir, path.join(dir, base + ".png")).split(path.sep).join("/");
  }

  // 아직 저장하지 않은 생성 결과 (저장 버튼을 누를 때까지 메모리에만 둔다, 최근 30장)
  const pending = new Map();
  function remember(png, meta) {
    const id = crypto.randomUUID();
    pending.set(id, { png, meta });
    while (pending.size > 30) pending.delete(pending.keys().next().value);
    return id;
  }
  async function save(id, folder) {
    const p = pending.get(id);
    if (!p) throw new Error("저장할 이미지를 찾지 못했습니다. 허브를 다시 시작했다면 다시 생성해야 합니다.");
    if (p.file) return { file: p.file, url: assetUrl(p.file) };
    p.file = await saveImage(p.png, p.meta, folder ?? p.meta.folder);
    return { file: p.file, url: assetUrl(p.file) };
  }
  const assetUrl = (file) => "/assets/" + file.split("/").map(encodeURIComponent).join("/");

  // PNG 안의 텍스트(tEXt/iTXt) 읽기 — NovelAI는 Comment에 생성 정보를 JSON으로 넣는다
  function pngText(buf) {
    const out = {};
    if (buf.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return out;
    for (let o = 8; o + 8 <= buf.length; ) {
      const len = buf.readUInt32BE(o);
      const type = buf.toString("latin1", o + 4, o + 8);
      const data = buf.subarray(o + 8, o + 8 + len);
      if (type === "tEXt") {
        const z = data.indexOf(0);
        out[data.toString("latin1", 0, z)] = data.subarray(z + 1).toString("utf8");
      } else if (type === "iTXt") {
        const z = data.indexOf(0);
        const key = data.toString("latin1", 0, z);
        const compressed = data[z + 1] === 1;
        let p = z + 3;
        p = data.indexOf(0, p) + 1; // 언어 태그
        p = data.indexOf(0, p) + 1; // 번역된 키
        const body = data.subarray(p);
        out[key] = (compressed ? zlib.inflateSync(body) : body).toString("utf8");
      } else if (type === "IEND") break;
      o += 12 + len;
    }
    return out;
  }
  function metaFromPng(buf) {
    const t = pngText(buf);
    let c = {};
    try {
      c = JSON.parse(t.Comment ?? "{}");
    } catch {}
    const v4 = c.v4_prompt?.caption, v4n = c.v4_negative_prompt?.caption;
    const src = `${t.Source ?? ""}`;
    const model = /V5/i.test(src) ? "nai-diffusion-5-full" : /V4\.5/i.test(src) ? "nai-diffusion-4-5-full" : /V4/i.test(src) ? "nai-diffusion-4-full" : /V3/i.test(src) ? "nai-diffusion-3" : undefined;
    return {
      prompt: v4?.base_caption ?? c.prompt ?? t.Description ?? "",
      negative: v4n?.base_caption ?? c.uc ?? "",
      characters: (v4?.char_captions ?? []).map((ch, i) => ({
        prompt: ch.char_caption ?? "", uc: v4n?.char_captions?.[i]?.char_caption ?? "", enabled: true,
        x: ch.centers?.[0]?.x ?? 0.5, y: ch.centers?.[0]?.y ?? 0.5,
      })),
      useCoords: !!c.v4_prompt?.use_coords,
      model, seed: c.seed, steps: c.steps, scale: c.scale, cfgRescale: c.cfg_rescale,
      sampler: c.sampler, noiseSchedule: c.noise_schedule, width: c.width, height: c.height,
    };
  }

  // ---------- 생성 (NDJSON으로 진행 상황을 흘려보낸다) ----------
  async function generate(req, res) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    const send = (o) => res.write(JSON.stringify(o) + "\n");
    const s = await settings();
    if (!s.apiKey) {
      send({ type: "error", message: "NovelAI API 키가 없습니다. 스튜디오 오른쪽 위 ⚙ 설정에서 입력하세요." });
      return res.end();
    }
    if (current) {
      send({ type: "error", message: "이미 생성 중입니다. 끝나거나 취소한 뒤 다시 시도하세요." });
      return res.end();
    }
    const controller = new AbortController();
    current = { controller };
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const { body, seed } = buildBody(req);
      const useStream = s.stream && req.stream !== false;
      if (useStream) body.parameters.stream = "sse";
      const url = `${IMAGE_BASE}/ai/${useStream ? "generate-image-stream" : "generate-image"}`;
      send({ type: "start", seed, steps: body.parameters.steps, width: body.parameters.width, height: body.parameters.height });
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = t;
        try {
          msg = JSON.parse(t).message ?? t;
        } catch {}
        const hint = r.status === 401 ? " (API 키를 확인하세요)" : r.status === 402 ? " (Anlas 또는 구독이 부족합니다)" : r.status === 429 ? " (요청이 너무 잦습니다. 잠시 후 다시 시도하세요)" : "";
        throw new Error(`NovelAI 오류 ${r.status}${hint}: ${String(msg).slice(0, 300)}`);
      }
      let finalPng = null;
      const ctype = r.headers.get("content-type") || "";
      if (useStream && ctype.includes("event-stream")) {
        // SSE: data: {"event_type":"intermediate"|"final", "step_ix":n, "image":"<base64>"}
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            let ev;
            try {
              ev = JSON.parse(data);
            } catch {
              continue;
            }
            if (ev.event_type === "intermediate" && ev.image) {
              send({ type: "progress", step: (ev.step_ix ?? 0) + 1, total: body.parameters.steps, image: ev.image });
            } else if (ev.event_type === "final" && ev.image) {
              finalPng = Buffer.from(ev.image, "base64");
            } else if (ev.event_type === "error" || ev.error) {
              throw new Error("NovelAI 스트림 오류: " + (ev.message || ev.error));
            }
          }
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        finalPng = buf.subarray(0, 4).toString("binary") === "PK\u0003\u0004" ? firstFileFromZip(buf) : buf;
      }
      if (!finalPng || finalPng.length < 100) {
        throw new Error("완성된 이미지를 받지 못했습니다. 설정에서 '생성 과정 실시간 보기'를 끄고 다시 시도해 보세요.");
      }
      const meta = {
        prompt: req.prompt ?? "", negative: req.negative ?? "", characters: req.characters ?? [], useCoords: !!req.useCoords,
        model: body.model, seed, width: body.parameters.width, height: body.parameters.height, steps: body.parameters.steps,
        scale: body.parameters.scale, cfgRescale: body.parameters.cfg_rescale, sampler: body.parameters.sampler,
        noiseSchedule: body.parameters.noise_schedule, presetName: req.presetName ?? null,
      };
      // 자동 저장하지 않는다: 메모리에 보관하고 화면에 보내 준 뒤, 저장 버튼을 누르면 저장
      const id = remember(finalPng, { ...meta, folder: req.folder });
      send({ type: "done", id, seed, image: finalPng.toString("base64"), meta });
    } catch (e) {
      send({ type: "error", message: controller.signal.aborted ? "취소했습니다." : e.message || String(e) });
    } finally {
      current = null;
      res.end();
    }
  }

  function cancel() {
    if (!current) return false;
    current.controller.abort();
    return true;
  }

  async function anlas() {
    const s = await settings();
    if (!s.apiKey) return null;
    const r = await fetch(`${API_BASE}/user/subscription`, { headers: { Authorization: `Bearer ${s.apiKey}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`구독 정보 조회 실패 (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`);
    const j = await r.json();
    const t = j.trainingStepsLeft ?? {};
    // V5 Opus 생성 한도 (NovelAI 웹과 같은 계산)
    const u = j.usage;
    const usage = u
      ? {
          percent: u.isNegative ? 0 : Math.max(0, Number(u.percent) || 0),
          extraPercent: Math.max(0, Number(u.purchasedPercent) || 0),
          perDay: u.timeUntilNextPercent > 0 ? Math.round((86400 / u.timeUntilNextPercent) * 10) / 10 : 0,
          isNegative: !!u.isNegative,
        }
      : null;
    return { anlas: (t.fixedTrainingStepsLeft ?? 0) + (t.purchasedTrainingSteps ?? 0), tier: j.tier ?? null, usage };
  }

  // ---------- 결과 목록 / 파일 ----------
  async function listAssets(limit = 120) {
    const s = await settings();
    const out = [];
    async function walk(dir) {
      let ents = [];
      try {
        ents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.toLowerCase().endsWith(".png")) {
          const st = await fs.stat(p);
          out.push({ file: path.relative(s.assetsDir, p).split(path.sep).join("/"), mtime: st.mtimeMs });
        }
      }
    }
    await walk(s.assetsDir);
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit).map((x) => ({ ...x, url: "/assets/" + x.file.split("/").map(encodeURIComponent).join("/") }));
  }

  // assets 폴더 밖은 절대 내주지 않는다
  async function resolveAsset(rel) {
    const s = await settings();
    const p = path.normalize(path.join(s.assetsDir, rel));
    if (!p.startsWith(path.normalize(s.assetsDir) + path.sep)) return null;
    return p;
  }

  async function assetMeta(rel) {
    const p = await resolveAsset(rel);
    if (!p) return null;
    try {
      return metaFromPng(await fs.readFile(p));
    } catch {
      return null;
    }
  }

  async function openFolder(rel) {
    const s = await settings();
    const target = rel ? await resolveAsset(rel) : s.assetsDir;
    if (!target) return false;
    await fs.mkdir(s.assetsDir, { recursive: true });
    const isFile = rel && target.toLowerCase().endsWith(".png");
    if (process.platform === "win32") spawn("explorer", isFile ? [`/select,${target}`] : [target], { detached: true, stdio: "ignore" }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [isFile ? path.dirname(target) : target], { detached: true, stdio: "ignore" }).unref();
    return true;
  }

  // ---------- 프롬프트 보관함 ----------
  const loadPrompts = () => readJson(PROMPTS, { items: [] });
  const savePrompts = (data) => writeJson(PROMPTS, { items: Array.isArray(data?.items) ? data.items : [] });

  return { publicSettings, saveSettings, generate, cancel, save, anlas, listAssets, resolveAsset, assetMeta, openFolder, loadPrompts, savePrompts };
}
