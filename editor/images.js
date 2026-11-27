"use strict";
// 상황 이미지 관리 화면. 티팟 미디어 관리와 같은 데이터 구조를 쓴다.
//   항목 하나 = { id, name, circumstance, image, publicImages? }
//   image가 문자열이면 이미지 한 장, 문자열 배열이면 폴더(채팅에서 그중 하나가 무작위로 보인다).
// 티팟과 같은 한도: 전체 500개, 폴더 하나에 50장, 파일 하나 5MB.

const IMG_MAX = 500;
const IMG_FOLDER_MAX = 50;
const IMG_FILE_MAX = 5 * 1024 * 1024;
const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const IMG_ACCEPT = ".jpg,.jpeg,.png,.gif,.webp,.avif";

// 화면 상태 (저장본 데이터가 아니라 보기 상태)
const IV = {
  folder: null, // 열어 본 폴더 항목 (객체 참조)
  sel: new Set(), // 선택한 것: 루트에서는 항목 객체, 폴더 안에서는 이미지 순번
  drag: null, // 끌고 있는 것 { kind: "item", item } | { kind: "inner", folder, index }
  mode: store.get("imgDragMode", "merge"), // merge(묶기) | move(이동)
  scroll: 0,
};

// ---------- 데이터 도우미 (티팟 코드와 같은 규칙) ----------
const isFolderImg = (x) => Array.isArray(x?.image);
const imgsOf = (x) => (isFolderImg(x) ? x.image : [x?.image]).filter((s) => typeof s === "string" && s.trim());
const firstImg = (x) => imgsOf(x)[0] ?? "";
const pubSet = (x) => new Set((x?.publicImages ?? []).filter((s) => typeof s === "string").map((s) => s.trim()));
const newImgId = () => `si-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const withId = (x) => (x.id ? x : { ...x, id: newImgId() });

// 갤러리 공개 표시(publicImages)는 그 항목에 실제로 있는 이미지만 남긴다
function fixPublic(item, sources = [item]) {
  const pub = new Set(sources.flatMap((s) => [...pubSet(s)]));
  const keep = imgsOf(item).filter((u) => pub.has(u.trim()));
  delete item.publicImages;
  if (keep.length) item.publicImages = keep;
  return item;
}

// 이름·상황 설명에 쓰인 숫자를 피해서 비어 있는 가장 작은 번호
function usedNums(list) {
  const s = new Set();
  for (const x of list) {
    for (const v of [x?.name, x?.circumstance]) {
      const n = parseInt(String(v ?? ""), 10);
      if (!Number.isNaN(n) && n >= 1) s.add(n);
    }
  }
  return s;
}
function nextNums(list, count) {
  const used = usedNums(list), out = [];
  for (let n = 1; out.length < count; n++) if (!used.has(n)) out.push(n);
  return out;
}

// ---------- 파일 → 티팟과 같은 data URL ----------
// 티팟: GIF·움직이는 WebP는 그대로, 나머지는 긴 변 2048px 이하 WebP(품질 92)로 바꾼다.
const readDataUrl = (blob) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("파일을 읽지 못했어요."));
    r.readAsDataURL(blob);
  });
async function isAnimatedWebp(file) {
  const b = new Uint8Array(await file.arrayBuffer());
  if (b.length < 12 || String.fromCharCode(...b.slice(0, 4)) !== "RIFF" || String.fromCharCode(...b.slice(8, 12)) !== "WEBP") return false;
  for (let i = 12; i < b.length - 4; i++) if (b[i] === 65 && b[i + 1] === 78 && b[i + 2] === 73 && b[i + 3] === 77) return true;
  return false;
}
async function fileToImage(file) {
  if (!IMG_TYPES.has(file.type)) throw new Error(`${file.name}: JPG·PNG·GIF·WEBP·AVIF만 올릴 수 있어요.`);
  if (file.size > IMG_FILE_MAX) throw new Error(`${file.name}: 5MB보다 커요.`);
  if (file.type === "image/gif" || (file.type === "image/webp" && (await isAnimatedWebp(file)))) return readDataUrl(file);
  const url = URL.createObjectURL(file);
  try {
    const im = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error(`${file.name}: 이미지를 열지 못했어요.`));
      i.src = url;
    });
    const w0 = im.naturalWidth, h0 = im.naturalHeight;
    if (!w0 || !h0) throw new Error(`${file.name}: 이미지 크기를 알 수 없어요.`);
    const k = Math.min(1, 2048 / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w0 * k));
    c.height = Math.max(1, Math.round(h0 * k));
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL("image/webp", 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}
const fileStem = (f) => (f.name || "").replace(/\.[^.]+$/, "").slice(0, 100).trim();

function pickFiles(multiple = true) {
  return new Promise((res) => {
    const inp = el("input", { type: "file", accept: IMG_ACCEPT, multiple });
    inp.addEventListener("change", () => res([...(inp.files ?? [])]));
    inp.click();
  });
}

async function convertFiles(files) {
  const ok = [];
  for (const f of files) {
    try {
      ok.push({ url: await fileToImage(f), stem: fileStem(f) });
    } catch (e) {
      toast(e.message, true);
    }
  }
  return ok;
}

// ---------- 화면 ----------
function renderImagesPane(it) {
  // 칸이 아예 없던 저장본이면 실제로 고칠 때만 만든다 (그냥 열어만 봐도 변경으로 잡히지 않게)
  const list = S.working.circumstance_images ?? [];
  // 열어 둔 폴더가 사라졌으면(되돌리기·삭제·풀기) 전체 보기로
  if (IV.folder && !(list.includes(IV.folder) && isFolderImg(IV.folder))) IV.folder = null;
  if (IV.lastIt !== it.id || IV.lastList !== list) IV.sel.clear();
  IV.lastIt = it.id;
  IV.lastList = list;
  const inFolder = IV.folder;

  const changed = () => refreshTreeItem(it.id);
  const rerender = () => {
    IV.scroll = $("#pane .form")?.scrollTop ?? 0;
    if (!S.working.circumstance_images) S.working.circumstance_images = list;
    changed();
    renderImagesPane(it);
  };

  // --- 동작 ---
  const addFiles = async (files, into = inFolder) => {
    if (!files.length) return;
    if (into && into.image.length + files.length > IMG_FOLDER_MAX) return toast(`폴더 하나에는 ${IMG_FOLDER_MAX}장까지 넣을 수 있어요.`, true);
    const got = await convertFiles(files);
    if (!got.length) return;
    if (into) {
      into.image.push(...got.map((g) => g.url));
      if (into !== inFolder) {
        toast(`「${into.name || "폴더"}」에 ${got.length}장을 넣었어요.`);
        return rerender();
      }
    } else {
      if (list.length + got.length > IMG_MAX) return toast(`이미지는 ${IMG_MAX}개까지 추가할 수 있어요.`, true);
      const nums = nextNums(list, got.length);
      got.forEach((g, i) => list.push({ id: newImgId(), name: String(nums[i]), circumstance: g.stem || String(nums[i]), image: g.url }));
    }
    toast(`이미지 ${got.length}장을 추가했어요.`);
    rerender();
  };

  const replaceImage = async (item, index) => {
    const [f] = await pickFiles(false);
    if (!f) return;
    const [g] = await convertFiles([f]);
    if (!g) return;
    if (index == null) item.image = g.url;
    else item.image[index] = g.url;
    fixPublic(item);
    rerender();
  };

  const newFolder = () => {
    if (list.length >= IMG_MAX) return toast(`이미지는 ${IMG_MAX}개까지 추가할 수 있어요.`, true);
    const [n] = nextNums(list, 1);
    list.push({ id: newImgId(), name: String(n), circumstance: String(n), image: [] });
    rerender();
  };

  const deleteItem = (item) => {
    const label = item.name || "이름 없음";
    const msg = isFolderImg(item)
      ? `폴더 「${label}」과 안에 든 이미지 ${imgsOf(item).length}장을 모두 삭제할까요? (저장해야 반영돼요)\n이미지만 꺼내려면 「풀기」를 쓰세요.`
      : `「${label}」 이미지를 삭제할까요? (저장해야 반영돼요)`;
    if (!confirm(msg)) return;
    list.splice(list.indexOf(item), 1);
    rerender();
  };

  // 폴더 풀기: 안의 이미지들을 「이름_(n)」 낱장으로 폴더 자리에 펼친다 (티팟과 같은 규칙)
  const unfold = (folder, ask = true) => {
    const imgs = folder.image;
    if (list.length - 1 + imgs.length > IMG_MAX) return toast(`이미지는 ${IMG_MAX}개까지만 둘 수 있어서 풀 수 없어요.`, true);
    if (ask && !confirm(`폴더를 풀면 이미지 ${imgs.length}장이 낱장으로 나뉘어요. 계속할까요?`)) return;
    const base = (folder.name ?? "").trim() || "폴더";
    const pub = pubSet(folder);
    const items = imgs.map((u, i) => ({
      id: newImgId(), image: u, name: `${base}_(${i + 1})`, circumstance: folder.circumstance ?? "",
      ...(pub.has(u.trim()) ? { publicImages: [u] } : {}),
    }));
    list.splice(list.indexOf(folder), 1, ...items);
    if (IV.folder === folder) IV.folder = null;
    rerender();
  };

  // 폴더에서 이미지 빼기 → 맨 뒤에 낱장으로 (원래 순서대로)
  const takeOut = (folder, indices) => {
    const idx = [...new Set(indices)].filter((i) => i >= 0 && i < folder.image.length).sort((x, y) => x - y);
    if (!idx.length) return;
    const emptied = idx.length === folder.image.length;
    if (list.length - (emptied ? 1 : 0) + idx.length > IMG_MAX) return toast(`이미지는 ${IMG_MAX}개까지만 둘 수 있어요.`, true);
    const pub = pubSet(folder);
    const urls = idx.map((i) => folder.image[i]);
    for (const i of [...idx].reverse()) folder.image.splice(i, 1);
    fixPublic(folder);
    if (emptied) {
      list.splice(list.indexOf(folder), 1);
      if (IV.folder === folder) IV.folder = null;
    }
    const nums = nextNums(list, urls.length);
    urls.forEach((u, k) => list.push({ id: newImgId(), name: String(nums[k]), circumstance: String(nums[k]), image: u, ...(pub.has(u.trim()) ? { publicImages: [u] } : {}) }));
    IV.sel.clear();
    toast(urls.length > 1 ? `${urls.length}장을 폴더에서 뺐어요. 맨 뒤에 있어요.` : "폴더에서 뺐어요. 맨 뒤에 있어요.");
    rerender();
  };

  const deleteInner = (folder, index) => {
    if (!confirm("이 이미지를 폴더에서 삭제할까요? (저장해야 반영돼요)")) return;
    folder.image.splice(index, 1);
    fixPublic(folder);
    rerender();
  };

  // 폴더(dst)에 넣기. 끌어온 것(srcs)이 폴더면 안의 이미지를 전부 옮기고 그 폴더는 없앤다.
  const putInto = (srcs, dst) => {
    srcs = srcs.filter((x) => x !== dst && list.includes(x));
    if (!srcs.length) return;
    const urls = srcs.flatMap(imgsOf);
    if (dst.image.length + urls.length > IMG_FOLDER_MAX) return toast(`폴더 하나에는 ${IMG_FOLDER_MAX}장까지 넣을 수 있어요. (지금 ${dst.image.length}장 + ${urls.length}장)`, true);
    const folders = srcs.filter(isFolderImg);
    if (folders.length && !confirm(`폴더 ${folders.length}개의 이미지를 「${dst.name || "폴더"}」로 옮기고 그 폴더는 없앨까요?`)) return;
    dst.publicImages = [...pubSet(dst), ...srcs.flatMap((x) => [...pubSet(x)])];
    dst.image.push(...urls);
    fixPublic(dst);
    for (const x of srcs) list.splice(list.indexOf(x), 1);
    IV.sel.clear();
    toast(`「${dst.name || "폴더"}」에 ${urls.length}장을 넣었어요.`);
    rerender();
  };

  // 묶기: 끌어온 것(srcs)을 대상(dst)에 겹친다
  const merge = (srcs, dst) => {
    srcs = srcs.filter((x) => x !== dst && list.includes(x));
    if (!srcs.length) return;
    if (isFolderImg(dst)) return putInto(srcs, dst);
    // 낱장 위에 놓으면 → 대상 자리에 새 폴더 (이름·설명은 대상 것)
    const urls = [...srcs.flatMap(imgsOf), ...imgsOf(dst)];
    if (urls.length > IMG_FOLDER_MAX) return toast(`폴더 하나에는 ${IMG_FOLDER_MAX}장까지 넣을 수 있어요.`, true);
    const all = [...srcs, dst];
    const folder = fixPublic({ id: newImgId(), image: urls, name: dst.name, circumstance: dst.circumstance, publicImages: all.flatMap((x) => [...pubSet(x)]) });
    const at = Math.min(...all.map((x) => list.indexOf(x)));
    for (const x of all) list.splice(list.indexOf(x), 1);
    list.splice(at, 0, folder);
    IV.sel.clear();
    toast(`${urls.length}장을 폴더로 묶었어요.`);
    rerender();
  };

  const moveInArray = (arr, from, to) => {
    if (from === to || from < 0) return false;
    const [x] = arr.splice(from, 1);
    arr.splice(from < to ? to - 1 : to, 0, x);
    return true;
  };

  // 선택한 것들을 새 폴더 하나로 (폴더를 고르면 그 안의 이미지 전부)
  const groupSelected = () => {
    const picked = list.filter((x) => IV.sel.has(x));
    const urls = picked.flatMap(imgsOf);
    if (!urls.length) return toast("묶을 이미지를 골라 주세요.");
    if (urls.length > IMG_FOLDER_MAX) return toast(`폴더 하나에는 ${IMG_FOLDER_MAX}장까지 넣을 수 있어요.`, true);
    const at = list.indexOf(picked[0]);
    const first = picked[0];
    const folder = fixPublic({ id: newImgId(), image: urls, name: first.name, circumstance: first.circumstance, publicImages: picked.flatMap((x) => [...pubSet(x)]) });
    for (const x of picked) list.splice(list.indexOf(x), 1);
    list.splice(Math.min(at, list.length), 0, folder);
    IV.sel.clear();
    toast(`${urls.length}장을 폴더로 묶었어요.`);
    rerender();
  };

  const deleteSelected = () => {
    if (inFolder) {
      const idx = [...IV.sel].sort((a, b) => b - a);
      if (!idx.length || !confirm(`선택한 이미지 ${idx.length}장을 폴더에서 삭제할까요? (저장해야 반영돼요)`)) return;
      for (const i of idx) inFolder.image.splice(i, 1);
      fixPublic(inFolder);
    } else {
      const picked = list.filter((x) => IV.sel.has(x));
      if (!picked.length || !confirm(`선택한 ${picked.length}개를 삭제할까요? 폴더는 안의 이미지까지 지워져요. (저장해야 반영돼요)`)) return;
      for (const x of picked) list.splice(list.indexOf(x), 1);
    }
    IV.sel.clear();
    rerender();
  };

  const takeOutSelected = () => takeOut(inFolder, [...IV.sel]);

  // --- 카드 그리기 ---
  const total = list.length;
  const grid = el("div", { class: "img-grid" });

  // 카드 위 어디에 놓는지: 폴더는 어느 방식이든 가운데에 놓으면 「폴더에 넣기」
  const DROP_CLS = ["drop-merge", "drop-into", "drop-before", "drop-after"];
  const clearDrop = (n) => n.classList.remove(...DROP_CLS);
  const zoneOf = (card, e, isFolder) => {
    const d = IV.drag;
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (!d) return isFolder ? "into" : null; // 컴퓨터에서 끌어온 파일
    if (d.mode === "merge") return isFolder ? "into" : "merge";
    if (isFolder && d.kind === "item" && x > 0.25 && x < 0.75) return "into";
    return x < 0.5 ? "before" : "after";
  };
  const dragHandlers = (card, target, isFolder, onDrop) => {
    card.addEventListener("dragover", (e) => {
      const files = !IV.drag && e.dataTransfer?.types?.includes("Files");
      if (!IV.drag && !files) return;
      if (IV.drag && IV.drag.target === target) return;
      const z = zoneOf(card, e, isFolder);
      if (!z) return; // 파일을 낱장 카드 위에 놓으면 화면 전체 추가로 넘긴다
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = files ? "copy" : "move";
      clearDrop(card);
      card.classList.add("drop-" + z);
    });
    card.addEventListener("dragleave", (e) => {
      if (!card.contains(e.relatedTarget)) clearDrop(card);
    });
    card.addEventListener("drop", (e) => {
      const files = !IV.drag && e.dataTransfer?.files?.length;
      if (!IV.drag && !files) return;
      const z = zoneOf(card, e, isFolder);
      clearDrop(card);
      if (!z) return;
      e.preventDefault();
      e.stopPropagation();
      $(".img-form")?.classList.remove("file-over");
      if (files) return addFiles([...e.dataTransfer.files], target);
      onDrop(z);
    });
  };

  const thumbEl = (src, alt, onOpen) => {
    const t = src ? el("img", { src, alt: alt ?? "", loading: "lazy", draggable: "false" }) : el("div", { class: "img-none" }, "이미지 없음");
    if (onOpen) t.addEventListener("click", onOpen);
    return t;
  };

  const handleOf = (card, payload) => {
    const h = el("div", { class: "img-thumb", draggable: "true", title: IV.mode === "merge" ? "끌어서 다른 이미지에 겹치면 폴더로 묶여요" : "끌어서 순서를 바꿔요" });
    h.addEventListener("dragstart", (e) => {
      // 선택한 카드를 끌면 선택한 것 전부를 함께 옮긴다 (폴더에 넣기·묶기)
      const many = payload.kind === "item" && IV.sel.has(payload.item) && IV.sel.size > 1 ? list.filter((x) => IV.sel.has(x)) : null;
      IV.drag = { ...payload, many, mode: payload.kind === "inner" ? "move" : IV.mode };
      if (many) document.querySelectorAll(".img-card.selected").forEach((n) => n.classList.add("dragging"));
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-teapot-image", "1");
      card.classList.add("dragging");
      $("#pane").classList.add("img-dragging");
    });
    h.addEventListener("dragend", () => {
      IV.drag = null;
      document.querySelectorAll(".img-card.dragging").forEach((n) => n.classList.remove("dragging"));
      $("#pane")?.classList.remove("img-dragging");
      document.querySelectorAll(".drop-merge,.drop-into,.drop-before,.drop-after").forEach(clearDrop);
    });
    return h;
  };

  const check = (key) => {
    const c = el("input", { type: "checkbox", class: "img-check", title: "선택" });
    c.checked = IV.sel.has(key);
    c.addEventListener("change", () => {
      c.checked ? IV.sel.add(key) : IV.sel.delete(key);
      c.closest(".img-card")?.classList.toggle("selected", c.checked);
      updateSelBar();
    });
    return c;
  };

  const textInputs = (item, tag) => {
    const name = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "이미지 이름", maxlength: "50" });
    name.value = item.name ?? "";
    name.addEventListener("input", () => {
      item.name = name.value;
      if (tag) tag.textContent = `{{img::${name.value}}}`;
      changed();
    });
    const circ = el("input", { class: "line", type: "text", spellcheck: "false", placeholder: "내용 (어떤 상황에 쓸지)", maxlength: "100" });
    circ.value = item.circumstance ?? "";
    circ.addEventListener("input", () => ((item.circumstance = circ.value), changed()));
    return [name, circ];
  };

  const tagEl = (item) => {
    const tag = el("code", { class: "img-tag", title: "클릭하면 복사돼요" }, `{{img::${item.name ?? ""}}}`);
    tag.addEventListener("click", () => navigator.clipboard?.writeText(tag.textContent).then(() => toast("이미지 태그를 복사했어요."), () => {}));
    return tag;
  };

  const btn = (label, onclick, cls = "") => el("button", { class: "small ghost " + cls, type: "button", onclick }, label);

  if (!inFolder) {
    list.forEach((item, i) => {
      const folder = isFolderImg(item);
      const imgs = imgsOf(item);
      const card = el("div", { class: "img-card" + (folder ? " is-folder" : "") + (IV.sel.has(item) ? " selected" : "") });
      const handle = handleOf(card, { kind: "item", item, target: item });
      if (folder) {
        const stack = el("div", { class: "img-stack" });
        imgs.slice(0, 3).reverse().forEach((u) => stack.append(el("img", { src: u, alt: "", loading: "lazy", draggable: "false" })));
        if (!imgs.length) stack.append(el("div", { class: "img-none" }, "빈 폴더"));
        handle.append(stack, el("span", { class: "img-badge" }, icon("folder", "ico"), ` ${imgs.length}장`));
        handle.addEventListener("click", () => ((IV.folder = item), IV.sel.clear(), (IV.scroll = 0), renderImagesPane(it)));
        handle.title += " · 클릭하면 폴더를 열어요";
      } else {
        handle.append(thumbEl(imgs[0], item.name, () => imgs[0] && openLightbox(imgs, 0)));
      }
      const tag = tagEl(item);
      card.append(
        handle,
        el("div", { class: "img-meta" }, check(item), el("span", { class: "muted-num" }, `#${i + 1}`), tag),
        ...textInputs(item, tag),
        el(
          "div",
          { class: "img-actions" },
          folder
            ? [btn("열기", () => ((IV.folder = item), IV.sel.clear(), (IV.scroll = 0), renderImagesPane(it))), btn("풀기", () => unfold(item))]
            : [btn("교체", () => replaceImage(item))],
          btn("삭제", () => deleteItem(item), "danger")
        )
      );
      dragHandlers(card, item, folder, (zone) => {
        const d = IV.drag;
        if (!d || d.kind === "inner") return; // 폴더 안 이미지는 폴더 화면 안에서만
        const srcs = d.many ?? [d.item];
        if (zone === "into") return putInto(srcs, item);
        if (zone === "merge") return merge(srcs, item);
        const from = list.indexOf(d.item);
        const to = list.indexOf(item) + (zone === "after" ? 1 : 0);
        if (moveInArray(list, from, to)) rerender();
      });
      grid.append(card);
    });
  } else {
    const folder = inFolder;
    folder.image.forEach((u, i) => {
      const card = el("div", { class: "img-card" + (IV.sel.has(i) ? " selected" : "") });
      const handle = handleOf(card, { kind: "inner", folder, index: i, target: i });
      handle.append(thumbEl(u, "", () => openLightbox(folder.image, i)));
      card.append(
        handle,
        el("div", { class: "img-meta" }, check(i), el("span", { class: "muted-num" }, `${i + 1} / ${folder.image.length}`), pubSet(folder).has(u.trim()) ? el("span", { class: "muted-num" }, "갤러리 공개") : null),
        el("div", { class: "img-actions" }, btn("교체", () => replaceImage(folder, i)), btn("빼기", () => takeOut(folder, [i])), btn("삭제", () => deleteInner(folder, i), "danger"))
      );
      dragHandlers(card, i, false, (zone) => {
        const d = IV.drag;
        if (!d || d.kind !== "inner" || d.folder !== folder) return;
        if (moveInArray(folder.image, d.index, i + (zone === "after" ? 1 : 0))) rerender();
      });
      grid.append(card);
    });
  }

  // --- 위쪽 도구 막대 ---
  const selBar = el("span", { class: "img-selbar" });
  function updateSelBar() {
    const n = IV.sel.size;
    selBar.replaceChildren(
      ...(n
        ? [
            el("span", { class: "count" }, `${n}개 선택`),
            inFolder ? btn("폴더에서 빼기", takeOutSelected) : btn("폴더로 묶기", groupSelected),
            btn("삭제", deleteSelected, "danger"),
            btn("선택 해제", () => {
              IV.sel.clear();
              renderImagesPane(it);
            }),
          ]
        : [])
    );
  }
  updateSelBar();

  const modeBtn = (m, label, tip) =>
    el("button", {
      type: "button", class: "small" + (IV.mode === m ? " on" : ""), title: tip,
      onclick: () => {
        IV.mode = m;
        store.set("imgDragMode", m);
        renderImagesPane(it);
      },
    }, label);

  const tools = el(
    "div",
    { class: "img-tools" },
    el("button", { class: "small primary", type: "button", onclick: async () => addFiles(await pickFiles(true)) }, inFolder ? "이 폴더에 이미지 추가" : "이미지 추가"),
    inFolder ? null : btn("빈 폴더 만들기", newFolder),
    inFolder
      ? null
      : el("span", { class: "img-mode", title: "끌어다 놓을 때 할 일" }, el("span", { class: "muted-num" }, "끌기:"), modeBtn("merge", "묶기", "다른 이미지에 겹치면 폴더로 묶기·폴더에 넣기"), modeBtn("move", "이동", "끌어서 순서만 바꾸기")),
    selBar
  );

  // 폴더 화면 머리: 경로 + 폴더 이름·내용
  let folderHead = null;
  if (inFolder) {
    const back = el("button", { class: "small ghost img-crumb", type: "button", title: "이미지를 여기로 끌어 놓으면 폴더에서 빠져요" }, "← 전체");
    back.addEventListener("click", () => ((IV.folder = null), IV.sel.clear(), (IV.scroll = 0), renderImagesPane(it)));
    back.addEventListener("dragover", (e) => {
      if (IV.drag?.kind === "inner") (e.preventDefault(), back.classList.add("drop-merge"));
    });
    back.addEventListener("dragleave", () => back.classList.remove("drop-merge"));
    back.addEventListener("drop", (e) => {
      if (IV.drag?.kind !== "inner") return;
      e.preventDefault();
      takeOut(IV.drag.folder, [IV.drag.index]);
    });
    const tag = tagEl(inFolder);
    const [name, circ] = textInputs(inFolder, tag);
    folderHead = el(
      "div",
      { class: "img-folder-head" },
      el("div", { class: "img-folder-path" }, back, el("span", { class: "muted-num" }, "›"), icon("folderOpen", "ico ico-folder"), el("b", {}, inFolder.name || "폴더"), el("span", { class: "count" }, `${inFolder.image.length}/${IMG_FOLDER_MAX}장`), tag),
      el("div", { class: "img-folder-fields" }, name, circ, btn("폴더 풀기", () => unfold(inFolder)), btn("폴더 삭제", () => deleteItem(inFolder), "danger"))
    );
  }

  const hint = inFolder
    ? "폴더 안 이미지는 시작 메시지에서 {{img::폴더 이름}}으로 부르면 그중 하나가 무작위로 보여요. 끌어서 순서를 바꾸고, 「← 전체」로 끌어 놓으면 폴더에서 빠져요."
    : "이미지를 폴더 카드 위에 끌어다 놓으면 폴더에 들어가요(「이동」일 때는 카드 가운데에 놓기). 「묶기」일 때 낱장끼리 겹치면 새 폴더가 돼요. 체크한 것을 끌면 함께 옮겨지고, 컴퓨터의 파일을 폴더 카드에 놓으면 그 폴더에 추가돼요. 저장해야 티팟에 반영돼요.";

  const form = el("div", { class: "form img-form" }, folderHead, tools, (inFolder ? inFolder.image.length : list.length) ? grid : el("div", { class: "muted img-empty" }, inFolder ? "빈 폴더예요. 이미지를 추가하거나 「← 전체」에서 이미지를 끌어 넣으세요." : "상황 이미지가 없어요. 「이미지 추가」를 누르거나 파일을 끌어다 놓으세요."));

  // 컴퓨터의 파일을 끌어다 놓기
  form.addEventListener("dragover", (e) => {
    if (IV.drag || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    form.classList.add("file-over");
  });
  form.addEventListener("dragleave", (e) => {
    if (e.target === form) form.classList.remove("file-over");
  });
  form.addEventListener("drop", (e) => {
    form.classList.remove("file-over");
    if (IV.drag || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  $("#pane").replaceChildren(
    paneHead(it, [el("span", { class: "count" }, `${total}/${IMG_MAX}개 · ${list.reduce((a, x) => a + imgsOf(x).length, 0)}장`)]),
    el("div", { class: "hint" }, hint),
    form
  );
  form.scrollTop = IV.scroll;
}

// 크게 보기 (← → 로 넘기기, 바깥 클릭·Esc로 닫기)
function openLightbox(urls, start) {
  let i = start;
  const img = el("img", { alt: "" });
  const cap = el("div", { class: "lb-cap" });
  const show = () => ((img.src = urls[i]), (cap.textContent = urls.length > 1 ? `${i + 1} / ${urls.length}` : ""));
  const box = el("div", { class: "lightbox", tabindex: "-1" }, img, cap);
  const close = () => (box.remove(), document.removeEventListener("keydown", key));
  const key = (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight" && urls.length > 1) (i = (i + 1) % urls.length), show();
    else if (e.key === "ArrowLeft" && urls.length > 1) (i = (i - 1 + urls.length) % urls.length), show();
  };
  box.addEventListener("click", (e) => {
    if (e.target === img && urls.length > 1) (i = (i + 1) % urls.length), show();
    else close();
  });
  document.addEventListener("keydown", key);
  show();
  document.body.append(box);
}
