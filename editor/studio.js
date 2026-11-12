"use strict";
// 에셋 스튜디오: NovelAI 이미지 생성 + 프롬프트 보관함 + 결과 갤러리
// app.js의 el, $, store, toast를 같이 쓴다.

const ST = {
  draft: null, // 현재 입력 상태
  library: { items: [] },
  libFilter: "",
  activePreset: null, // 불러온 프롬프트 id
  editors: {}, // 이름 -> CodeMirror
  busy: false,
  settings: null,
  view: null, // 오른쪽에 보이는 이미지 {url, file, meta}
  built: false,
  session: [], // 이번 세션에 생성한 결과 { id, url, meta, file }
};

const MODELS = [
  ["nai-diffusion-5-full", "V5 Full"],
  ["nai-diffusion-5-curated", "V5 Curated"],
  ["nai-diffusion-4-5-full", "V4.5 Full"],
  ["nai-diffusion-4-5-curated", "V4.5 Curated"],
  ["nai-diffusion-4-full", "V4 Full"],
  ["nai-diffusion-4-curated-preview", "V4 Curated"],
  ["nai-diffusion-3", "V3 Anime"],
  ["nai-diffusion-furry-3", "V3 Furry"],
];
const SAMPLERS = [
  ["k_euler_ancestral", "Euler Ancestral"], ["k_euler", "Euler"], ["k_dpmpp_2s_ancestral", "DPM++ 2S Ancestral"],
  ["k_dpmpp_2m_sde", "DPM++ 2M SDE"], ["k_dpmpp_2m", "DPM++ 2M"], ["k_dpmpp_sde", "DPM++ SDE"],
];
const SCHEDULES = [["karras", "Karras"], ["exponential", "Exponential"], ["polyexponential", "Polyexponential"]];
const SIZES = [
  ["832x1216", "세로 832×1216"], ["1216x832", "가로 1216×832"], ["1024x1024", "정사각 1024×1024"],
  ["512x768", "작은 세로 512×768"], ["768x512", "작은 가로 768×512"], ["custom", "직접 입력"],
];
// NovelAI 웹이 자동으로 붙이는 문구 (NovelAI 웹 코드 기준 모델별 기본값, 화면에서 고칠 수 있음)
const isV5 = (m) => /nai-diffusion-5/.test(m);
const QUALITY_V5 = { standard: ", very aesthetic, masterpiece, no text", light: ", very aesthetic, amazing quality, no text" };
const UC_V5 = {
  heavy: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  light: "lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::",
};
// V5 Effort: Medium은 별도 모델 + 고정 설정 (14스텝, Euler Ancestral, Heavy UC, 캐릭터별 부정 프롬프트 없음)
const MEDIUM_FIXED = { steps: 14, sampler: "k_euler_ancestral", ucPreset: "heavy" };
const QUALITY_TEXT = {
  "nai-diffusion-5-full": QUALITY_V5.standard,
  "nai-diffusion-5-curated": QUALITY_V5.standard,
  "nai-diffusion-4-5-full": ", very aesthetic, masterpiece, no text",
  "nai-diffusion-4-5-curated": ", very aesthetic, masterpiece, no text",
  "nai-diffusion-4-full": ", no text, best quality, very aesthetic, absurdres",
  "nai-diffusion-4-curated-preview": ", rating:general, amazing quality, very aesthetic, absurdres",
  "nai-diffusion-3": ", best quality, amazing quality, very aesthetic, absurdres",
  "nai-diffusion-furry-3": ", {best quality}, {amazing quality}",
};
const UC_TEXT = {
  heavy: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  light: "lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page",
};
const ucTextFor = (model, preset) => (isV5(model) ? UC_V5[preset] : UC_TEXT[preset]) ?? "";
const POS = [0.1, 0.3, 0.5, 0.7, 0.9];

const DEFAULT_DRAFT = () => ({
  prompt: "", negative: "",
  characters: [],
  useCoords: false,
  model: "nai-diffusion-5-full", effort: "high", mode: "anime",
  size: "832x1216", width: 832, height: 1216,
  steps: 28, scale: 5, cfgRescale: 0, sampler: "k_euler_ancestral", noiseSchedule: "karras",
  seed: "", quality: true, qualityPreset: "standard", qualityText: QUALITY_V5.standard,
  ucPreset: "heavy", ucText: UC_V5.heavy,
  folder: "",
});

const sapi = async (p, body = {}) => {
  const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "요청 실패");
  return j.result;
};

function saveDraft() {
  store.set("studio:draft", ST.draft);
}

// ---------------- 화면 전환 ----------------
function setMode(mode) {
  document.body.classList.toggle("mode-studio", mode === "studio");
  document.querySelectorAll(".modes .mode").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  store.set("mode", mode);
  if (mode === "studio") {
    if (!ST.built) buildStudio();
    refreshAnlas();
    refreshGallery();
  }
}

// ---------------- 스튜디오 구성 ----------------
function buildStudio() {
  ST.built = true;
  ST.draft = { ...DEFAULT_DRAFT(), ...store.get("studio:draft", {}) };
  const root = $("#studio");
  root.replaceChildren(
    el("aside", { class: "st-lib" },
      el("div", { class: "st-lib-head" }, el("strong", {}, "프롬프트 보관함"), el("button", { class: "small", onclick: () => savePreset(true) }, "+ 새로 저장")),
      el("input", { class: "tree-search", type: "search", placeholder: "이름·폴더·내용 검색", oninput: (e) => ((ST.libFilter = e.target.value.trim().toLowerCase()), renderLibrary()) }),
      el("div", { id: "stLibList", class: "st-lib-list" })
    ),
    el("section", { class: "st-form", id: "stForm" }),
    el("section", { class: "st-out" },
      el("div", { class: "st-viewer", id: "stViewer" }, el("div", { class: "st-empty" }, "생성한 이미지가 여기에 표시됩니다.")),
      el("div", { class: "st-progress hidden", id: "stProgress" }, el("div", { class: "st-progress-bar", id: "stProgressBar" })),
      el("div", { class: "st-out-bar", id: "stOutBar" }),
      // 생성 버튼은 결과 화면 쪽(생성 기록 바로 위)에 둔다. 설정을 아무리 내려도 항상 보이도록.
      el("div", { class: "st-gen-bar" },
        el("button", { class: "primary st-gen", id: "stGen", onclick: generate }, "생성 (Ctrl+Enter)"),
        el("button", { class: "", id: "stCancel", disabled: true, onclick: () => sapi("/api/nai/cancel") }, "취소"),
        el("span", { id: "stFree", class: "badge" })
      ),
      el("div", { class: "st-gallery-head" }, el("strong", {}, "생성 기록"), el("button", { class: "small ghost", onclick: () => sapi("/api/assets/open").catch((e) => toast(e.message, true)) }, "폴더 열기"), el("button", { class: "small ghost", onclick: refreshGallery }, "새로고침")),
      el("div", { class: "st-gallery", id: "stGallery" })
    )
  );
  renderForm();
  loadLibrary();
  document.addEventListener("keydown", onStudioKey, true);
}

function onStudioKey(e) {
  if (!document.body.classList.contains("mode-studio")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    generate();
  } else if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    e.stopImmediatePropagation();
    savePreset(false);
  }
}

// ---------------- 입력 폼 ----------------
function promptBox(key, label, placeholder, minRows = 4) {
  const host = el("div", { class: "cm-host st-cm", style: `--rows:${minRows}` });
  const ed = TPV.createEditor({
    parent: host, doc: ST.draft[key] ?? "", lang: "plain", gutter: false, wrap: true, placeholder,
    onChange: (v) => ((ST.draft[key] = v), saveDraft()),
  });
  ST.editors[key]?.destroy();
  ST.editors[key] = ed;
  return el("div", { class: "st-field" }, el("label", {}, label), host);
}

function sel(options, value, onChange) {
  const s = el("select", { class: "sel" }, options.map(([v, t]) => el("option", { value: v }, t)));
  s.value = String(value);
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
function num(value, attrs, onChange) {
  const i = el("input", { class: "line st-num", type: "number", ...attrs });
  i.value = value;
  i.addEventListener("input", () => onChange(i.value === "" ? "" : Number(i.value)));
  return i;
}
const row = (label, ...kids) => el("label", { class: "st-row" }, el("span", {}, label), ...kids);

function renderForm() {
  // 다시 그려도 스크롤 위치를 유지한다
  const prevScroll = $("#stForm")?.scrollTop ?? 0;
  queueMicrotask(() => {
    const f = $("#stForm");
    if (f) f.scrollTop = prevScroll;
  });
  const d = ST.draft;
  for (const k of Object.keys(ST.editors)) ST.editors[k].destroy();
  ST.editors = {};
  const isV4 = /nai-diffusion-[45]/.test(d.model);
  const v5 = isV5(d.model);
  const medium = d.model === "nai-diffusion-5-full" && d.effort === "medium";
  const set = (k) => (v) => ((d[k] = v), saveDraft());

  // 캐릭터 프롬프트 카드
  const chars = el("div", { class: "st-chars" });
  d.characters.forEach((c, i) => {
    const card = el("div", { class: "st-char" + (c.enabled === false ? " off" : "") });
    const en = el("input", { type: "checkbox", class: "check" });
    en.checked = c.enabled !== false;
    en.addEventListener("change", () => ((c.enabled = en.checked), card.classList.toggle("off", !en.checked), saveDraft()));
    const pos = el("span", { class: "st-pos" + (d.useCoords ? "" : " hidden") },
      "위치", sel(POS.map((v) => [v, ["왼쪽", "왼쪽-가운데", "가운데", "가운데-오른쪽", "오른쪽"][POS.indexOf(v)]]), c.x ?? 0.5, (v) => ((c.x = Number(v)), saveDraft())),
      sel(POS.map((v) => [v, ["위", "위-가운데", "가운데", "가운데-아래", "아래"][POS.indexOf(v)]]), c.y ?? 0.5, (v) => ((c.y = Number(v)), saveDraft()))
    );
    const mk = (key, ph) => {
      const host = el("div", { class: "cm-host st-cm", style: "--rows:2" });
      const ed = TPV.createEditor({ parent: host, doc: c[key] ?? "", lang: "plain", gutter: false, wrap: true, placeholder: ph, onChange: (v) => ((c[key] = v), saveDraft()) });
      ST.editors[`char${i}-${key}`] = ed;
      return host;
    };
    card.append(
      el("div", { class: "st-char-head" },
        el("label", { class: "st-inline" }, en, ` 캐릭터 ${i + 1}`),
        pos,
        el("span", { class: "spacer" }),
        el("button", { class: "small ghost", title: "위로", onclick: () => moveChar(i, -1) }, "↑"),
        el("button", { class: "small ghost", title: "아래로", onclick: () => moveChar(i, 1) }, "↓"),
        el("button", { class: "small ghost danger", onclick: () => (d.characters.splice(i, 1), saveDraft(), renderForm()) }, "삭제")
      ),
      el("div", { class: "st-sub" }, "긍정"), mk("prompt", "예: girl, short hair, blue eyes, school uniform"),
      ...(medium ? [] : [el("div", { class: "st-sub" }, "부정"), mk("uc", "이 캐릭터에서 빼고 싶은 요소")])
    );
    chars.append(card);
  });

  const sizeSel = sel(SIZES, d.size, (v) => {
    d.size = v;
    if (v !== "custom") [d.width, d.height] = v.split("x").map(Number);
    saveDraft();
    renderForm();
  });
  const free = d.width * d.height <= 1024 * 1024 && d.steps <= 28;

  const form = $("#stForm");
  form.replaceChildren(
    promptBox("prompt", "긍정 프롬프트", "장면 전체에 들어갈 태그나 문장 (예: 2girls, classroom, afternoon, sunlight)", 5),
    promptBox("negative", "부정 프롬프트", "빼고 싶은 요소", 3),
    el("div", { class: "st-field" },
      el("div", { class: "st-chars-head" },
        el("label", {}, `캐릭터 프롬프트 (${d.characters.length}/6)`),
        isV4 ? el("label", { class: "st-inline", title: "끄면 위치를 AI가 정합니다" }, (() => {
          const c = el("input", { type: "checkbox", class: "check" });
          c.checked = d.useCoords;
          c.addEventListener("change", () => ((d.useCoords = c.checked), saveDraft(), renderForm()));
          return c;
        })(), " 위치 직접 지정") : null,
        el("span", { class: "spacer" }),
        el("button", { class: "small", disabled: !isV4 || d.characters.length >= 6, onclick: () => (d.characters.push({ prompt: "", uc: "", enabled: true, x: 0.5, y: 0.5 }), saveDraft(), renderForm()) }, "+ 캐릭터 추가")
      ),
      isV4 ? chars : el("div", { class: "muted" }, "캐릭터 프롬프트는 V4 이상 모델에서만 쓸 수 있습니다.")
    ),
    el("details", { class: "st-settings", open: store.get("studio:settingsOpen", true), ontoggle: (e) => store.set("studio:settingsOpen", e.target.open) },
      el("summary", {}, "생성 설정"),
      el("div", { class: "st-grid" },
        row("모델", sel(MODELS, d.model, (v) => {
          if (d.qualityText === QUALITY_TEXT[d.model] || Object.values(QUALITY_V5).includes(d.qualityText)) d.qualityText = isV5(v) ? QUALITY_V5[d.qualityPreset] ?? QUALITY_V5.standard : QUALITY_TEXT[v] ?? d.qualityText;
          if (d.ucText === ucTextFor(d.model, d.ucPreset)) d.ucText = ucTextFor(v, d.ucPreset);
          d.model = v;
          saveDraft();
          renderForm();
        })),
        v5 ? row("모드", sel([["anime", "Anime"], ["furry", "Furry"]], d.mode, set("mode"))) : null,
        d.model === "nai-diffusion-5-full"
          ? row("Effort", sel([["high", "High"], ["medium", "Medium"]], d.effort, (v) => {
              d.effort = v;
              if (v === "medium" && d.ucPreset !== "heavy") (d.ucPreset = "heavy"), (d.ucText = UC_V5.heavy);
              saveDraft();
              renderForm();
            }))
          : null,
        row("크기", sizeSel),
        row("너비", num(d.width, { min: 64, max: 2048, step: 64, disabled: d.size !== "custom" }, set("width"))),
        row("높이", num(d.height, { min: 64, max: 2048, step: 64, disabled: d.size !== "custom" }, set("height"))),
        row("스텝", num(medium ? MEDIUM_FIXED.steps : d.steps, { min: 1, max: 50, disabled: medium, title: medium ? "Effort Medium은 14스텝 고정" : "" }, (v) => (set("steps")(v), renderFreeBadge()))),
        row("가이던스", num(d.scale, { min: 0, max: 10, step: 0.1 }, set("scale"))),
        row("CFG 리스케일", num(medium ? 0 : d.cfgRescale, { min: 0, max: 1, step: 0.02, disabled: medium }, set("cfgRescale"))),
        row("샘플러", (() => {
          const s = sel(SAMPLERS, medium ? MEDIUM_FIXED.sampler : d.sampler, set("sampler"));
          s.disabled = medium;
          return s;
        })()),
        row("노이즈 스케줄", sel(SCHEDULES, d.noiseSchedule, set("noiseSchedule"))),
        row("시드", num(d.seed, { min: 0, placeholder: "비우면 무작위" }, set("seed")),
          el("button", { class: "small ghost", title: "무작위로", onclick: () => ((d.seed = ""), saveDraft(), renderForm()) }, "🎲")),
        row("저장 폴더", (() => {
          const i = el("input", { class: "line", type: "text", placeholder: "예: 캐릭터 이름 (비우면 날짜 폴더만)" });
          i.value = d.folder ?? "";
          i.addEventListener("input", () => set("folder")(i.value));
          return i;
        })())
      ),
      el("div", { class: "st-auto" },
        el("label", { class: "st-inline" }, (() => {
          const c = el("input", { type: "checkbox", class: "check" });
          c.checked = d.quality;
          c.addEventListener("change", () => set("quality")(c.checked));
          return c;
        })(), " 품질 태그 자동 추가 (긍정 프롬프트 뒤)",
          v5 ? sel([["standard", "Standard"], ["light", "Light"]], d.qualityPreset ?? "standard", (v) => {
            d.qualityPreset = v;
            d.qualityText = QUALITY_V5[v];
            saveDraft();
            renderForm();
          }) : null),
        (() => {
          const i = el("input", { class: "line", type: "text" });
          i.value = d.qualityText;
          i.addEventListener("input", () => set("qualityText")(i.value));
          return i;
        })(),
        el("label", { class: "st-inline" }, "UC 프리셋 (부정 프롬프트 앞) ", (() => {
          const s = sel([["heavy", "Heavy"], ["light", "Light"], ["none", "사용 안 함"]], d.ucPreset, (v) => {
            d.ucPreset = v;
            d.ucText = ucTextFor(d.model, v);
            saveDraft();
            renderForm();
          });
          if (medium) (s.disabled = true), (s.title = "Effort Medium은 Heavy 고정");
          return s;
        })()),
        d.ucPreset !== "none"
          ? (() => {
              const i = el("textarea", { class: "st-uc", rows: 2 });
              i.value = d.ucText;
              i.addEventListener("input", () => set("ucText")(i.value));
              return i;
            })()
          : null
      )
    ),
    el("div", { class: "st-actions" },
      el("span", { class: "spacer" }),
      el("span", { class: "muted-num", id: "stPresetName" }, ST.activePreset ? `불러온 프롬프트: ${presetById(ST.activePreset)?.name ?? ""}` : ""),
      ST.activePreset ? el("button", { class: "small", onclick: () => savePreset(false), title: "Ctrl+S" }, "보관함에 덮어쓰기") : null
    )
  );
  renderFreeBadge();
  void free;
}

function renderFreeBadge() {
  const d = ST.draft;
  const b = $("#stFree");
  if (!b) return;
  const free = d.width * d.height <= 1024 * 1024 && Number(d.steps) <= 28;
  b.className = "badge " + (free ? "fixed" : "payg");
  b.textContent = !free ? "Anlas 소모" : isV5(d.model) ? "Opus 한도 사용" : "Opus 무료 범위";
  b.title = isV5(d.model)
    ? "V5는 Opus 구독 시 일반 해상도·28스텝 이하가 무료지만, Opus 생성 한도(%)를 사용합니다. 한도가 바닥나면 Anlas가 차감됩니다."
    : "Opus 구독은 1024×1024 이하, 28스텝 이하, 1장 생성이 무료입니다.";
}

function moveChar(i, dlt) {
  const a = ST.draft.characters;
  const j = i + dlt;
  if (j < 0 || j >= a.length) return;
  [a[i], a[j]] = [a[j], a[i]];
  saveDraft();
  renderForm();
}

// ---------------- 생성 ----------------
function requestFromDraft(d) {
  const medium = d.model === "nai-diffusion-5-full" && d.effort === "medium";
  let prompt = d.quality && d.qualityText ? `${d.prompt}${d.qualityText}` : d.prompt;
  // Furry 모드: NovelAI 웹과 같이 앞에 "fur dataset, "을 붙인다
  if (isV5(d.model) && d.mode === "furry" && !/^(fur dataset|background dataset)/.test(prompt)) prompt = `fur dataset, ${prompt}`;
  const ucText = medium ? UC_V5.heavy : d.ucText;
  const ucOn = medium || d.ucPreset !== "none";
  const negative = ucOn && ucText ? [ucText, d.negative].filter((x) => x && x.trim()).join(", ") : d.negative;
  const characters = medium ? d.characters.map((c) => ({ ...c, uc: "" })) : d.characters;
  return {
    prompt, negative, characters, useCoords: d.useCoords, model: medium ? "nai-diffusion-5-full-medium" : d.model,
    width: Number(d.width), height: Number(d.height), steps: medium ? MEDIUM_FIXED.steps : Number(d.steps), scale: Number(d.scale),
    cfgRescale: medium ? 0 : Number(d.cfgRescale), sampler: medium ? MEDIUM_FIXED.sampler : d.sampler, noiseSchedule: d.noiseSchedule,
    seed: d.seed === "" ? 0 : Number(d.seed), qualityToggle: !!d.quality, ucPreset: { heavy: 0, light: 1, none: 3 }[d.ucPreset] ?? 0,
    folder: d.folder, presetName: presetById(ST.activePreset)?.name ?? null,
  };
}

function imgSrc(b64) {
  return `data:image/${b64.startsWith("iVBOR") ? "png" : "jpeg"};base64,${b64}`;
}

async function generate() {
  if (ST.busy) return;
  if (!ST.settings?.hasKey) {
    await loadSettings();
    if (!ST.settings?.hasKey) return openSettings("먼저 NovelAI API 키를 입력하세요.");
  }
  if (!ST.draft.prompt.trim() && !ST.draft.characters.some((c) => (c.prompt || "").trim())) return toast("프롬프트를 입력하세요.", true);
  ST.busy = true;
  $("#stGen").disabled = true;
  $("#stCancel").disabled = false;
  const prog = $("#stProgress"), bar = $("#stProgressBar"), viewer = $("#stViewer");
  prog.classList.remove("hidden");
  bar.style.width = "0%";
  let liveImg = null;
  try {
    const r = await fetch("/api/nai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Teapot-Agent": "1" },
      body: JSON.stringify(requestFromDraft(ST.draft)),
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "start") {
          liveImg = el("img", { class: "st-live", alt: "" });
          viewer.replaceChildren(el("div", { class: "st-wait" }, `생성 중… (시드 ${ev.seed})`), liveImg);
          liveImg.style.aspectRatio = `${ev.width} / ${ev.height}`;
        } else if (ev.type === "progress") {
          bar.style.width = `${Math.round((ev.step / ev.total) * 100)}%`;
          if (liveImg) {
            liveImg.src = imgSrc(ev.image);
            viewer.querySelector(".st-wait")?.remove();
          }
        } else if (ev.type === "done") {
          bar.style.width = "100%";
          // 자동 저장하지 않는다: 이번 세션 결과로 보관하고 저장 버튼으로 저장
          const item = { id: ev.id, url: imgSrc(ev.image), meta: ev.meta, file: null };
          ST.session.unshift(item);
          if (ST.session.length > 30) ST.session.pop();
          await showAsset(item);
          refreshGallery();
          refreshAnlas();
        } else if (ev.type === "error") {
          throw new Error(ev.message);
        }
      }
    }
  } catch (e) {
    toast(e.message, true);
    if (!ST.view) viewer.replaceChildren(el("div", { class: "st-empty err-text" }, e.message));
    else showAsset(ST.view);
  } finally {
    ST.busy = false;
    $("#stGen").disabled = false;
    $("#stCancel").disabled = true;
    setTimeout(() => prog.classList.add("hidden"), 600);
  }
}

// ---------------- 결과 보기 / 갤러리 ----------------
async function showAsset(a) {
  const meta = a.meta ?? (await sapi("/api/assets/meta", { file: a.file }).catch(() => null));
  ST.view = { ...a, meta };
  const viewer = $("#stViewer");
  const img = el("img", { src: a.url, alt: a.file ?? "" });
  viewer.replaceChildren(a.file ? el("a", { href: assetHref(a.file), target: "_blank", title: "새 탭에서 원본 보기" }, img) : img);
  const bar = $("#stOutBar");
  bar.replaceChildren(
    ...[
      a.file
        ? el("span", { class: "muted-num st-file", title: a.file }, a.file)
        : el("span", { class: "st-unsaved" }, "저장 안 됨"),
      el("span", { class: "spacer" }),
      meta ? el("button", { class: "small", onclick: () => loadFromMeta(meta, false) }, "프롬프트 불러오기") : null,
      meta ? el("button", { class: "small", onclick: () => loadFromMeta(meta, true), title: "같은 시드로 다시 생성할 수 있게 시드까지 불러옵니다" }, "시드까지 불러오기") : null,
      a.file
        ? el("button", { class: "small ghost", onclick: () => sapi("/api/assets/open", { file: a.file }).catch((e) => toast(e.message, true)) }, "파일 위치")
        : el("button", { class: "small primary", id: "stSave", title: "저장 폴더 설정에 따라 assets 폴더에 PNG로 저장합니다", onclick: () => saveResult(a) }, "저장"),
    ].filter(Boolean)
  );
  document.querySelectorAll(".st-thumb.sel").forEach((t) => t.classList.remove("sel"));
  document.querySelector(`.st-thumb[data-key="${CSS.escape(a.file ?? a.id)}"]`)?.classList.add("sel");
}

const assetHref = (file) => "/assets/" + file.split("/").map(encodeURIComponent).join("/");

async function saveResult(item) {
  const b = $("#stSave");
  if (b) b.disabled = true;
  try {
    const r = await sapi("/api/nai/save", { id: item.id, folder: ST.draft.folder });
    item.file = r.file;
    toast(`저장했습니다: ${r.file}`);
    await refreshGallery();
    if (ST.view?.id === item.id) showAsset(item);
  } catch (e) {
    toast(e.message, true);
    if (b) b.disabled = false;
  }
}

async function refreshGallery() {
  if (!ST.built) return;
  try {
    const list = await sapi("/api/assets/list", { limit: 120 });
    const g = $("#stGallery");
    const unsaved = ST.session.filter((x) => !x.file);
    const thumb = (a, key, extra = "") =>
      el("button", { class: "st-thumb" + extra + ((ST.view?.file ?? ST.view?.id) === key ? " sel" : ""), "data-key": key, title: a.file ?? "저장 안 됨", onclick: () => showAsset(a) },
        el("img", { src: a.url, alt: "", loading: "lazy" }));
    g.replaceChildren(
      ...(unsaved.length || list.length
        ? [...unsaved.map((a) => thumb(a, a.id, " unsaved")), ...list.map((a) => thumb(a, a.file))]
        : [el("div", { class: "muted" }, "아직 생성한 이미지가 없습니다.")])
    );
  } catch (e) {
    $("#stGallery").replaceChildren(el("div", { class: "muted" }, e.message));
  }
}

// 이미지 생성 정보에서 입력값 되살리기 (자동 추가 문구는 떼어 낸다)
function loadFromMeta(m, withSeed) {
  const d = ST.draft;
  let prompt = m.prompt ?? "";
  if (d.qualityText && prompt.endsWith(d.qualityText)) prompt = prompt.slice(0, -d.qualityText.length);
  let negative = m.negative ?? "";
  if (d.ucText && negative.startsWith(d.ucText)) negative = negative.slice(d.ucText.length).replace(/^,\s*/, "");
  let mode = "anime";
  if (prompt.startsWith("fur dataset, ")) (prompt = prompt.slice("fur dataset, ".length)), (mode = "furry");
  const medium = m.model === "nai-diffusion-5-full-medium";
  Object.assign(d, {
    prompt, negative, characters: structuredClone(m.characters ?? []), useCoords: !!m.useCoords,
    model: medium ? "nai-diffusion-5-full" : m.model ?? d.model, effort: medium ? "medium" : "high", mode, width: m.width ?? d.width, height: m.height ?? d.height,
    steps: m.steps ?? d.steps, scale: m.scale ?? d.scale, cfgRescale: m.cfgRescale ?? d.cfgRescale,
    sampler: m.sampler ?? d.sampler, noiseSchedule: m.noiseSchedule ?? d.noiseSchedule,
    seed: withSeed ? m.seed : "",
  });
  d.size = SIZES.some(([v]) => v === `${d.width}x${d.height}`) ? `${d.width}x${d.height}` : "custom";
  saveDraft();
  renderForm();
  toast(withSeed ? "프롬프트와 시드를 불러왔습니다." : "프롬프트를 불러왔습니다.");
}

// ---------------- 프롬프트 보관함 ----------------
const presetById = (id) => ST.library.items.find((x) => x.id === id);

async function loadLibrary() {
  try {
    ST.library = await sapi("/api/prompts/load");
  } catch (e) {
    toast("보관함을 불러오지 못했습니다: " + e.message, true);
  }
  renderLibrary();
}
async function persistLibrary() {
  await sapi("/api/prompts/save", ST.library);
  renderLibrary();
}

async function savePreset(asNew) {
  const cur = presetById(ST.activePreset);
  if (!asNew && cur) {
    cur.data = structuredClone(ST.draft);
    cur.updatedAt = Date.now();
    await persistLibrary();
    return toast(`「${cur.name}」에 덮어썼습니다.`);
  }
  const name = prompt("저장할 이름", ST.draft.prompt.slice(0, 30) || "새 프롬프트");
  if (!name) return;
  const folder = prompt("폴더 (비워도 됩니다. 예: 캐릭터 이름, 배경)", cur?.folder ?? ST.draft.folder ?? "") ?? "";
  const item = { id: crypto.randomUUID(), name: name.trim(), folder: folder.trim(), data: structuredClone(ST.draft), updatedAt: Date.now() };
  ST.library.items.unshift(item);
  ST.activePreset = item.id;
  await persistLibrary();
  renderForm();
  toast(`「${item.name}」을(를) 보관함에 저장했습니다.`);
}

function applyPreset(item) {
  ST.draft = { ...DEFAULT_DRAFT(), ...structuredClone(item.data) };
  ST.activePreset = item.id;
  saveDraft();
  renderForm();
  renderLibrary();
}

function renderLibrary() {
  const list = $("#stLibList");
  if (!list) return;
  const q = ST.libFilter;
  const items = ST.library.items.filter((x) => !q || `${x.name} ${x.folder} ${x.data?.prompt ?? ""}`.toLowerCase().includes(q));
  const groups = new Map();
  for (const it of items) {
    const k = it.folder || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "ko")));
  if (!items.length) return list.replaceChildren(el("div", { class: "muted" }, q ? "찾는 프롬프트가 없습니다." : "저장한 프롬프트가 없습니다. 프롬프트를 입력한 뒤 '+ 새로 저장'을 누르세요."));
  list.replaceChildren(
    ...keys.map((k) =>
      el("div", { class: "folder" },
        el("div", { class: "row" }, icon("folderOpen", "ico ico-folder-open"), el("span", { class: "label" }, k || "폴더 없음"), el("span", { class: "meta" }, String(groups.get(k).length))),
        el("div", { class: "children" },
          groups.get(k).map((it) =>
            el("div", { class: "item row" + (it.id === ST.activePreset ? " selected" : ""), onclick: () => applyPreset(it), title: it.data?.prompt ?? "" },
              icon("file", "ico ico-file"),
              el("span", { class: "label" }, it.name),
              el("span", { class: "actions" },
                el("button", { title: "이름·폴더 변경", onclick: (e) => (e.stopPropagation(), renamePreset(it)) }, "이름"),
                el("button", { title: "복제", onclick: (e) => (e.stopPropagation(), duplicatePreset(it)) }, "복제"),
                el("button", { title: "삭제", onclick: (e) => (e.stopPropagation(), deletePreset(it)) }, "삭제")
              )
            )
          )
        )
      )
    )
  );
}
async function renamePreset(it) {
  const name = prompt("이름", it.name);
  if (name == null) return;
  const folder = prompt("폴더", it.folder ?? "");
  if (folder == null) return;
  Object.assign(it, { name: name.trim() || it.name, folder: folder.trim(), updatedAt: Date.now() });
  await persistLibrary();
}
async function duplicatePreset(it) {
  const copy = { ...structuredClone(it), id: crypto.randomUUID(), name: it.name + " (복사)", updatedAt: Date.now() };
  ST.library.items.splice(ST.library.items.indexOf(it) + 1, 0, copy);
  await persistLibrary();
}
async function deletePreset(it) {
  if (!confirm(`「${it.name}」을(를) 보관함에서 삭제할까요?`)) return;
  ST.library.items = ST.library.items.filter((x) => x !== it);
  if (ST.activePreset === it.id) ST.activePreset = null;
  await persistLibrary();
  renderForm();
}

// ---------------- 설정 / Anlas ----------------
async function loadSettings() {
  try {
    ST.settings = await sapi("/api/nai/settings");
  } catch {}
  return ST.settings;
}

async function refreshAnlas() {
  const a = $("#anlas");
  await loadSettings();
  if (!ST.settings?.hasKey) return (a.textContent = "API 키 없음");
  try {
    const r = await sapi("/api/nai/anlas");
    if (!r) return (a.textContent = "");
    const u = r.usage;
    a.replaceChildren(
      el("span", { class: "anlas-num" }, `Anlas ${r.anlas.toLocaleString()}`),
      u
        ? el("span", { class: "usage" + (u.percent < 10 ? " low" : "") },
            el("span", { class: "usage-bar" }, el("i", { style: `width:${Math.min(100, u.percent)}%` })),
            `V5 한도 ${Math.round(u.percent)}%${u.extraPercent > 0 ? ` +${Math.round(u.extraPercent)}%` : ""}`)
        : null
    );
    a.title = u
      ? `Opus 생성 한도 (V5): 남은 양 ${u.percent}%${u.extraPercent ? `, 추가 사용량 ${u.extraPercent}%` : ""}\n하루 약 ${u.perDay}%씩 자동으로 다시 채워집니다.\n한도가 바닥나면 Anlas가 차감됩니다.`
      : "NovelAI 잔여 Anlas";
  } catch (e) {
    a.textContent = "Anlas 확인 실패";
    a.title = e.message;
  }
}

function openSettings(msg) {
  const s = ST.settings ?? {};
  const key = el("input", { class: "line", type: "password", autocomplete: "off", placeholder: s.hasKey ? `저장됨 (${s.keyHint}) — 바꿀 때만 입력` : "pst-로 시작하는 영구 API 토큰" });
  const dir = el("input", { class: "line", type: "text" });
  dir.value = s.assetsDir ?? "";
  const stream = el("input", { type: "checkbox", class: "check" });
  stream.checked = s.stream !== false;
  const close = () => dlg.remove();
  const dlg = el("div", { class: "st-modal", onclick: (e) => e.target === dlg && close() },
    el("div", { class: "st-modal-box" },
      el("h3", {}, "에셋 스튜디오 설정"),
      msg ? el("div", { class: "banner" }, msg) : null,
      el("label", { class: "st-field" }, el("span", {}, "NovelAI API 키"), key,
        el("small", { class: "muted-num" }, "NovelAI 웹 → 설정(⚙) → Account → Get Persistent API Token에서 발급합니다. 키는 이 PC의 config/settings.json에만 저장됩니다.")),
      el("label", { class: "st-field" }, el("span", {}, "이미지 저장 폴더"), dir),
      el("label", { class: "st-inline" }, stream, " 생성 과정 실시간 보기 (스트리밍)"),
      el("div", { class: "st-actions" },
        s.hasKey ? el("button", { class: "small ghost danger", onclick: async () => {
          if (!confirm("저장된 API 키를 지울까요?")) return;
          ST.settings = await sapi("/api/nai/settings", { apiKey: "" });
          close();
          refreshAnlas();
        } }, "키 지우기") : null,
        el("span", { class: "spacer" }),
        el("button", { onclick: close }, "취소"),
        el("button", { class: "primary", onclick: async () => {
          const patch = { assetsDir: dir.value, stream: stream.checked };
          if (key.value.trim()) patch.apiKey = key.value.trim();
          try {
            ST.settings = await sapi("/api/nai/settings", patch);
            close();
            toast("설정을 저장했습니다.");
            refreshAnlas();
            refreshGallery();
          } catch (e) {
            toast(e.message, true);
          }
        } }, "저장")
      )
    )
  );
  document.body.append(dlg);
  key.focus();
}

// ---------------- 시작 ----------------
document.querySelectorAll(".modes .mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$("#btnStudioSettings").addEventListener("click", async () => (await loadSettings(), openSettings()));
setMode(store.get("mode", "char"));
