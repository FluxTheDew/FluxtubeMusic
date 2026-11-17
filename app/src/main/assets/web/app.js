/* FLUX::MUSIC arayüzü.
 *
 * `window.FM` Kotlin tarafındaki köprü (MainActivity.Bridge). Tarayıcıda
 * açılırsa (geliştirme) sahte bir köprü devreye giriyor.
 *
 * Kural: hiçbir dokunuş mevcut sırayı sessizce silmez. Sırayı değiştiren tek
 * şeyler açıkça "ÇAL / KARIŞIK / TEMİZLE" diyen düğmeler.
 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const FM = window.FM || mockBridge();
  // Teşhis: Kotlin "başladı / hazır" ve dokunuş sayısını görsün (arayüz açılmazsa teşhis penceresi).
  try { if (FM.boot) FM.boot("start"); } catch (e) { /* yok */ }
  document.addEventListener("pointerdown", () => { try { if (FM.touch) FM.touch(); } catch (e) { /* yok */ } }, true);

  // --- JS hatası: ekranda kırmızı şerit + OLAYLAR'a kayıt (telefonda hata ayıklamak için) ---------
  function showErr(msg) {
    try { if (FM.jsError) FM.jsError(String(msg)); } catch (e) { /* yok */ }
    const el = document.getElementById("jserr");
    if (!el) return;
    el.hidden = false;
    el.textContent = "HATA: " + msg + "\n(kapatmak için dokun · AYAR → OLAYLAR'da da var)";
  }
  window.addEventListener("error", (e) => showErr((e.message || "hata") + " @" + (e.lineno || "?") + ":" + (e.colno || "?")));
  window.addEventListener("unhandledrejection", (e) => showErr("promise: " + ((e.reason && e.reason.message) || e.reason)));
  document.getElementById("jserr").addEventListener("click", (e) => { e.currentTarget.hidden = true; });

  // --- Kotlin'e uzun işler: FM.x(req, …) → FMcb(req, sonuç) -------------------------

  let reqN = 0;
  const waiting = new Map();
  window.FMcb = (id, json) => {
    const cb = waiting.get(id);
    waiting.delete(id);
    if (!cb) return;
    let r;
    try { r = JSON.parse(json); } catch (e) { cb.rej(e); return; }
    if (r.ok) cb.res(r.data); else cb.rej(new Error(r.error || "hata"));
  };
  function call(name, ...args) {
    return new Promise((res, rej) => {
      const id = ++reqN;
      waiting.set(id, { res, rej });
      try { FM[name](id, ...args); } catch (e) { waiting.delete(id); rej(e); }
    });
  }
  const J = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };
  /** Köprü çağrısı hata verirse arayüz çökmesin: hatayı kaydet, varsayılanı dön. */
  const safe = (fn, d) => {
    try { return fn(); } catch (e) { showErr((e && e.message) || e); return d; }
  };

  // --- yardımcılar ------------------------------------------------------------------

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
  }
  function bytes(n) {
    if (n > 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
    return Math.round(n / (1 << 20)) + " MB";
  }
  /** Türkçe büyük/küçük ve aksan farkı gözetmeyen arama anahtarı. */
  const norm = (s) => String(s || "").toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "");

  /**
   * Kapak: kitaplıktaki şarkılar telefondaki kopyadan (https://fm.art/…, Kotlin
   * yakalıyor; yoksa bir kez indirip saklıyor). Arama sonuçları doğrudan uzaktan.
   */
  function artHtml(song, remote) {
    let src = "";
    if (song) src = remote ? (song.thumb || "") : "https://fm.art/" + encodeURIComponent(song.id);
    return '<div class="art">' + (src ? '<img loading="lazy" src="' + esc(src) + '" onerror="this.remove()" alt="">' : "") + "</div>";
  }

  /** Liste kapağı (kendi resmin / YT kapağı / ilk şarkı): Kotlin "pl:<id>" isteğini çözüyor. */
  function coverUrl(p) {
    return "https://fm.art/" + encodeURIComponent("pl:" + p.id) + "?v=" + (p.coverV || 0);
  }
  function coverHtml(p) {
    return '<div class="art"><img loading="lazy" src="' + esc(coverUrl(p)) + '" onerror="this.remove()" alt=""></div>';
  }

  let toastTimer = 0;
  function toast(text, bad) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast is-on" + (bad ? " is-bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 1900);
  }

  // --- durum ------------------------------------------------------------------------

  let S = { ready: false };
  let queue = [];
  let qrev = -1, lrev = -1, drev = -1, lastIndex = -2;
  let lib = [];
  let prefs = J(safe(() => FM.prefs(), "{}"), {});
  let tab = "home";
  let playerOpen = false;
  let settingsOpen = false;

  try { $("#ver").textContent = "v" + FM.version(); } catch (e) { /* yok */ }

  // --- sekmeler ----------------------------------------------------------------------

  function go(t) {
    if (t === tab) {
      // Aynı sekmeye tekrar dokun: başa kaydır.
      const pg = $(".view.is-active .page");
      if (pg) pg.scrollTo({ top: 0, behavior: "smooth" });
    }
    tab = t;
    $$(".bnav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.dataset.view === t));
    if (t === "lib") renderLib();
    if (t === "search") renderSearchState();
    if (t === "home") renderHome();
    renderMini();
  }
  $$(".bnav button").forEach((b) => b.addEventListener("click", () => {
    // Alt menü her yerde: açık sayfaları kapatıp sekmeye git.
    closeMenu(); closePlayer(); closeSettings();
    if (!$("#sheet").hidden) closeSheet();
    go(b.dataset.tab);
  }));
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g) { closePlayer(); closeSettings(); if (!$("#sheet").hidden) closeSheet(); go(g.dataset.go); }
  });

  // --- animasyonlar (ayarlardan: her biri aç/kapa + hız) ------------------------------------

  const ANIMS = [
    { k: "tab", n: "Sekme geçişi", d: "ANA SAYFA · ARA · KİTAPLIK arasında", base: 200 },
    { k: "over", n: "Sayfalar", d: "çalar, ayarlar, liste / sanatçı sayfaları, ayar alt sayfaları", base: 260 },
    { k: "menu", n: "Alt menüler", d: "⋯ menüleri, profil menüsü", base: 220 },
    { k: "modal", n: "Pencereler", d: "isim sorma, onay pencereleri", base: 170 },
    { k: "toast", n: "Bildirimler", d: "alttaki kısa mesajlar", base: 180 },
  ];
  const ANIM_KEY = "fm.anim";
  let anim = {};
  function animDefaults() { const o = {}; ANIMS.forEach((x) => { o[x.k] = { on: true, speed: 1 }; }); return o; }
  try { anim = Object.assign(animDefaults(), JSON.parse(localStorage.getItem(ANIM_KEY) || "{}")); } catch (e) { anim = animDefaults(); }
  /** Bu animasyonun şu anki süresi (ms); kapalıysa 0. */
  function ams(k) {
    const d = ANIMS.find((x) => x.k === k);
    const c = anim[k] || { on: true, speed: 1 };
    return c.on && d ? Math.round(d.base / (Number(c.speed) || 1)) : 0;
  }
  function applyAnim() {
    ANIMS.forEach((x) => document.documentElement.style.setProperty("--t-" + x.k, ams(x.k) + "ms"));
    try { localStorage.setItem(ANIM_KEY, JSON.stringify(anim)); } catch (e) { /* yok */ }
  }
  applyAnim();

  /** Sınıfı kaldırıp yeniden ekle: animasyon baştan oynasın. */
  function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  function showOver(el) {
    el._tok = (el._tok || 0) + 1;
    el.hidden = false;
    el.classList.remove("a-out");
    replay(el, "a-in");
  }
  function hideOver(el, instant) {
    const tok = (el._tok = (el._tok || 0) + 1);
    el.classList.remove("a-in");
    const t = instant ? 0 : ams("over");
    if (!t) { el.hidden = true; return; }
    el.classList.add("a-out");
    setTimeout(() => { if (el._tok !== tok) return; el.hidden = true; el.classList.remove("a-out"); }, t);
  }

  /** Tam ekran sayfalar alt menünün (ve mini çaların) üstünde bitsin. */
  function layoutChrome() {
    const mini = $("#mini");
    const top = !mini.hidden ? mini.getBoundingClientRect().top : $(".bnav").getBoundingClientRect().top;
    document.documentElement.style.setProperty("--chrome", Math.max(0, Math.round(window.innerHeight - top)) + "px");
  }
  window.addEventListener("resize", layoutChrome);

  // --- tam ekran: çalar ve ayarlar -------------------------------------------------------

  function openPlayer() {
    playerOpen = true;
    showOver($("#player"));
    renderMini();
    $("#now-page").scrollTop = 0;
  }
  function closePlayer(instant) {
    if (!playerOpen) return;
    playerOpen = false;
    hideOver($("#player"), instant === true);
    renderMini();
  }

  let setPage = null;
  function openSettings() {
    settingsOpen = true;
    showOver($("#settings"));
    showSetMenu(false);
    renderPrefs(); renderDownloads(); renderStats(); renderAccount(); renderAnim();
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    hideOver($("#settings"));
  }
  /** Ayarlar: her işlemin kendi sayfası. */
  function openSub(k) {
    setPage = k;
    const t = $('#set-menu [data-open="' + k + '"] b');
    $("#settings-title").textContent = t ? t.textContent.toLocaleUpperCase("tr") : "AYARLAR";
    $("#set-menu").hidden = true;
    $$("#settings .sp").forEach((p) => { p.hidden = p.dataset.sp !== k; });
    const p = $('#settings .sp[data-sp="' + k + '"]');
    if (p) replay(p, "a-in");
    $("#settings .page").scrollTop = 0;
    if (k === "log") pollLogs();
    if (k === "dl") { renderDownloads(); renderStats(); }
    if (k === "anim") renderAnim();
  }
  function showSetMenu(animate) {
    setPage = null;
    $("#settings-title").textContent = "AYARLAR";
    $$("#settings .sp").forEach((p) => { p.hidden = true; });
    const m = $("#set-menu");
    m.hidden = false;
    if (animate) replay(m, "a-in");
  }
  $("#set-menu").addEventListener("click", (e) => {
    const t = e.target.closest("[data-open]");
    if (t) openSub(t.dataset.open);
  });
  $("#player-close").addEventListener("click", () => closePlayer());
  $("#settings-close").addEventListener("click", () => { if (setPage) showSetMenu(true); else closeSettings(); });
  $("#gear").addEventListener("click", openSettings);

  // Çaları aşağı çekerek kapat (sayfa en üstteyken); sayfa kaymışsa elle kaydır.
  (function pullToClose() {
    const pl = $("#player");
    const page = $("#now-page");
    let st = null;
    pl.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".over-head, .np") || e.target.closest("input, button")) return;
      st = { x: e.clientX, y: e.clientY, dy: 0, mode: null, s0: page.scrollTop, head: !!e.target.closest(".over-head") };
    });
    pl.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.mode) {
        if (Math.abs(dy) < 10 || Math.abs(dy) < Math.abs(dx)) { if (Math.abs(dx) > 14) st = null; return; }
        // Başlıktan çekmek her zaman kapatır; kapaktan çekmek sadece sayfa en üstteyken.
        st.mode = st.head ? (dy > 0 ? "pull" : "none") : (st.s0 > 0 || dy < 0 ? "scroll" : "pull");
        if (st.mode === "none") { st = null; return; }
        if (st.mode === "pull") pl.classList.add("is-pull");
      }
      if (st.mode === "scroll") { page.scrollTop = st.s0 - dy; return; }
      st.dy = Math.max(0, dy);
      pl.style.transform = "translateY(" + st.dy + "px)";
    });
    const end = () => {
      if (!st) return;
      const s0 = st;
      st = null;
      if (s0.mode !== "pull") return;
      pl.classList.remove("is-pull");
      pl.classList.add("pull-back");
      if (s0.dy > 110) {
        pl.style.transform = "translateY(100%)";
        setTimeout(() => { pl.classList.remove("pull-back"); pl.style.transform = ""; closePlayer(true); }, 200);
      } else {
        pl.style.transform = "";
        setTimeout(() => pl.classList.remove("pull-back"), 220);
      }
    };
    pl.addEventListener("pointerup", end);
    pl.addEventListener("pointercancel", end);
  })();
  $("#player-more").addEventListener("click", () => menu({
    title: "SIRA",
    sub: queue.length + " şarkı",
    items: [
      { g: "⤮", t: "Sıradakileri karıştır", fn: () => $("#c-shuf").click() },
      { g: "≡", t: "Sırayı liste olarak kaydet", fn: () => $("#q-save").click() },
      { g: "✕", t: "Sırayı temizle", danger: true, fn: () => $("#q-clear").click() },
    ],
  }));

  // Android geri tuşu: önce açık pencere, sonra ana sekme; en son uygulama arka plana.
  window.onBack = () => {
    if ($(".modal:not(.a-out)")) { closeModal($(".modal:not(.a-out)")); return true; }
    if ($(".scrim:not(.a-out)")) { closeMenu(); return true; }
    if (!$("#sheet").hidden) { closeSheet(); return true; }
    if (playerOpen) { closePlayer(); return true; }
    if (settingsOpen && setPage) { showSetMenu(true); return true; }
    if (settingsOpen) { closeSettings(); return true; }
    if (tab !== "home") { go("home"); return true; }
    return false;
  };

  // --- sıraya ekleme ---------------------------------------------------------------

  const MODE_TOAST = {
    now: "▶ çalıyor",
    next: "↳ sıradaki",
    end: "＋ sıraya eklendi",
    replace: "▶ sıra yenilendi",
    shuffle: "⤮ karışık çalıyor",
  };
  function enqueue(songs, mode, start) {
    if (!songs || !songs.length) return;
    const n = FM.enqueue(JSON.stringify(songs), mode, start || 0);
    const what = songs.length > 1 ? n + " şarkı " : "";
    toast((mode === "end" || mode === "next") && songs.length > 1 ? what + MODE_TOAST[mode] : MODE_TOAST[mode]);
    setTimeout(poll, 120);
  }
  function tapSong(song, ctx) {
    // Ana sayfa ve aramada: sıra tamamen o şarkı olur (öneriler açıksa arkası kendiliğinden gelir).
    if (ctx && (ctx.kind === "home" || ctx.kind === "search")) { enqueue([song], "replace"); return; }
    enqueue([song], prefs.tap || "now");
  }

  // --- şarkı satırları (kitaplık, arama, liste) -----------------------------------------------

  /**
   * opts: { remote, handle, ctx:{ kind, pid } }
   * Satırlar liste öğesine bağlanan dizideki sıra numarasını (data-k) taşıyor.
   */
  function songRow(s, k, opts) {
    const o = opts || {};
    const off = !S.online && !s.dl;
    const meta = [];
    if (s.dl) meta.push(s.local ? '<span class="dl">◆</span>' : '<span class="dl">↓</span>');
    if (s.liked) meta.push('<span class="lk">♥</span>');
    meta.push(esc(s.artist || "—"));
    if (s.views) meta.push(esc(s.views));
    if (s.album) meta.push(esc(s.album));
    if (s.dur) meta.push(fmt(s.dur));
    return '<div class="row' + (off ? " is-nope" : "") + '" data-k="' + k + '">' +
      (o.handle ? '<span class="handle">≡</span>' : "") +
      artHtml(s, o.remote) +
      '<div class="t"><div class="nm">' + esc(s.title) + '</div><div class="ar">' + meta.join(" · ") + "</div></div>" +
      '<button class="add" type="button" data-act="add" aria-label="sıraya ekle">＋</button>' +
      '<button class="more" type="button" data-act="more" aria-label="menü">⋯</button>' +
      "</div>";
  }

  /** Bir listeye satır davranışı: dokun / ＋ / ⋯ / uzun bas. */
  function bindSongList(el, getItems, getCtx, sel, attr) {
    sel = sel || ".row";
    attr = attr || "k";
    let lp = null, lpFired = false;
    el.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(sel);
      if (!row || e.target.closest(".handle, [data-act]")) return;
      lpFired = false;
      const x = e.clientX, y = e.clientY;
      lp = { x, y, t: setTimeout(() => {
        lpFired = true;
        const it = getItems()[Number(row.dataset[attr])];
        if (it && it.kind === "pl") { openListMenu(it.id); return; }
        if (it && it.kind === "song" || it && !it.kind) openSongMenu(it, Object.assign({ k: Number(row.dataset[attr]), items: getItems() }, getCtx ? getCtx() : {}));
      }, 520) };
    });
    const cancel = (e) => {
      if (!lp) return;
      if (e.type === "pointermove" && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 10) return;
      clearTimeout(lp.t); lp = null;
    };
    el.addEventListener("pointermove", cancel);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    attachSwipe(el, "＋ SIRAYA", (row) => {
      const it = getItems()[Number(row.dataset[attr])];
      if (it && (it.kind === "song" || !it.kind)) enqueue([it], "end");
    });
    el.addEventListener("click", (e) => {
      if (lpFired) { lpFired = false; return; }
      if (Date.now() - (el._swipeAt || 0) < 350) return;
      const row = e.target.closest(sel);
      if (!row || e.target.closest(".handle")) return;
      const k = Number(row.dataset[attr]);
      const items = getItems();
      const it = items[k];
      if (!it) return;
      const ctx = Object.assign({ k, items }, getCtx ? getCtx() : {});
      if (it.kind === "list") { openYtList(it.list || it.url, it.title, it.thumb); return; }
      if (it.kind === "artist") { openArtist(it.artist, it.title, it.thumb); return; }
      if (it.kind === "pl") { openPlaylist(it.id); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "add") { if (ctx.onAdd) ctx.onAdd(it, k); else enqueue([it], "end"); }
      else if (act === "more") openSongMenu(it, ctx);
      else tapSong(it, ctx);
    });
  }

  /**
   * Satırı soldan sağa kaydır → onGo(row). Dikey kaydırma bozulmasın diye
   * sadece belirgin yatay harekette devreye girer. Yatay kayan rafların içinde kapalı.
   */
  function attachSwipe(listEl, label, onGo) {
    let st = null;
    listEl.addEventListener("pointerdown", (e) => {
      const row = e.target.closest(".row");
      if (!row || row.closest(".hscroll") || e.target.closest(".handle, input")) return;
      st = { row, x: e.clientX, y: e.clientY, dx: 0, on: false };
    });
    listEl.addEventListener("pointermove", (e) => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.on) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { st = null; return; }
        if (dx < 14 || dx < Math.abs(dy) * 1.4) return;
        st.on = true;
        st.hint = document.createElement("div");
        st.hint.className = "swipe-hint";
        st.hint.textContent = label;
        st.row.prepend(st.hint);
        st.row.classList.add("is-swiping");
        listEl._swipeAt = Date.now();
      }
      st.dx = Math.max(0, dx);
      const w = st.row.offsetWidth;
      const shown = st.dx < 90 ? st.dx : 90 + (st.dx - 90) * 0.35;
      [...st.row.children].forEach((c) => { if (c !== st.hint) c.style.transform = "translateX(" + Math.min(shown, w * 0.6) + "px)"; });
      st.hint.classList.toggle("is-go", st.dx >= 90);
    });
    const end = () => {
      if (!st) return;
      const s0 = st;
      st = null;
      if (!s0.on) return;
      listEl._swipeAt = Date.now();
      const kids = [...s0.row.children].filter((c) => c !== s0.hint);
      kids.forEach((c) => { c.style.transition = "transform 0.18s ease-out"; c.style.transform = ""; });
      setTimeout(() => {
        kids.forEach((c) => { c.style.transition = ""; });
        if (s0.hint) s0.hint.remove();
        s0.row.classList.remove("is-swiping");
      }, 190);
      if (s0.dx >= 90) onGo(s0.row);
    };
    listEl.addEventListener("pointerup", end);
    listEl.addEventListener("pointercancel", end);
  }

  /** ≡ tutamacından sürükleyerek sıralama. onMove(from, to). */
  function makeDraggable(listEl, onMove) {
    listEl.addEventListener("pointerdown", (e) => {
      const h = e.target.closest(".handle");
      if (!h) return;
      const row = h.closest(".row");
      const rows = $$(".row", listEl);
      const from = rows.indexOf(row);
      if (from < 0) return;
      e.preventDefault();
      const H = row.offsetHeight;
      const scroller = listEl.closest(".page, .sheet-body") || document.scrollingElement;
      const y0 = e.clientY, s0 = scroller.scrollTop;
      let to = from, lastY = y0, raf = 0;
      listEl.classList.add("is-dragging");
      row.classList.add("is-drag");
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* yok */ }

      const layout = () => {
        const dy = lastY - y0 + (scroller.scrollTop - s0);
        row.style.transform = "translateY(" + dy + "px)";
        to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / H)));
        rows.forEach((r, i) => {
          if (r === row) return;
          let sh = 0;
          if (from < to && i > from && i <= to) sh = -H;
          if (from > to && i < from && i >= to) sh = H;
          r.style.transform = sh ? "translateY(" + sh + "px)" : "";
        });
      };
      // Kenara yaklaşınca kendiliğinden kaydır.
      const auto = () => {
        const r = scroller.getBoundingClientRect();
        const edge = 56;
        let v = 0;
        if (lastY < r.top + edge) v = -Math.ceil((r.top + edge - lastY) / 6);
        else if (lastY > r.bottom - edge) v = Math.ceil((lastY - (r.bottom - edge)) / 6);
        if (v) { scroller.scrollTop += v; layout(); }
        raf = requestAnimationFrame(auto);
      };
      raf = requestAnimationFrame(auto);
      const move = (ev) => { lastY = ev.clientY; layout(); };
      const up = () => {
        cancelAnimationFrame(raf);
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        rows.forEach((r) => { r.style.transform = ""; });
        row.classList.remove("is-drag");
        listEl.classList.remove("is-dragging");
        if (to !== from) onMove(from, to);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }

  // --- ÇALAN ---------------------------------------------------------------------------------

  let seeking = false;
  let npId = null;

  function renderNow() {
    const c = S.cur;
    const np = $("#np");
    np.classList.toggle("is-on", !!S.playing);
    if ((c && c.id) !== npId) {
      npId = c ? c.id : null;
      $("#np-art").outerHTML = artHtml(c, false).replace('<div class="art">', '<div class="art" id="np-art">');
      $("#np-title").textContent = c ? c.title : "sıra boş";
      $("#np-artist").textContent = c ? (c.artist || "—") : "kitaplıktan ya da aramadan şarkı ekle";
    }
    const badges = [];
    if (c) {
      if (c.local) badges.push('<span class="badge">YEREL</span>');
      else if (c.dl) badges.push('<span class="badge">↓ İNDİRİLDİ</span>');
      else if (!S.online) badges.push('<span class="badge red">ÇEVRİMİÇİ GEREK</span>');
      else badges.push('<span class="badge">AKIŞ</span>');
      if (S.state === 2 && S.want) badges.push('<span class="badge red">YÜKLENİYOR…</span>');
      if (c.liked) badges.push('<span class="badge red">♥</span>');
    }
    const bh = badges.join("");
    if ($("#np-badges").innerHTML !== bh) $("#np-badges").innerHTML = bh;

    const playing = S.want && S.state !== 4 && S.count > 0;
    const pb = $("#c-play");
    pb.textContent = playing ? "❚❚" : "▶";
    pb.classList.toggle("is-on", !!S.playing);

    const dur = (S.dur || 0) / 1000, pos = (S.pos || 0) / 1000;
    if (!seeking) {
      const v = dur > 0 ? Math.round((pos / dur) * 1000) : 0;
      const sk = $("#np-seek");
      sk.value = v;
      sk.style.setProperty("--p", v / 10 + "%");
      $("#np-pos").textContent = fmt(pos);
    }
    $("#np-dur").textContent = fmt(dur || (c && c.dur) || 0);

    const rep = $("#c-rep");
    rep.setAttribute("aria-pressed", String(S.repeat > 0));
    rep.textContent = S.repeat === 1 ? "↻1" : "↻";
  }

  $("#np-seek").addEventListener("input", (e) => {
    seeking = true;
    const v = Number(e.target.value);
    e.target.style.setProperty("--p", v / 10 + "%");
    $("#np-pos").textContent = fmt(((S.dur || 0) / 1000) * (v / 1000));
  });
  $("#np-seek").addEventListener("change", (e) => {
    FM.seek(((S.dur || 0) * Number(e.target.value)) / 1000);
    setTimeout(() => { seeking = false; }, 300);
  });
  $("#c-play").addEventListener("click", () => { FM.toggle(); setTimeout(poll, 100); });
  $("#c-next").addEventListener("click", () => { FM.next(); setTimeout(poll, 100); });
  $("#c-prev").addEventListener("click", () => { FM.prev(); setTimeout(poll, 100); });
  $("#c-rep").addEventListener("click", () => {
    FM.repeat();
    const nxt = { 0: "tekrar: tüm sıra", 2: "tekrar: tek şarkı", 1: "tekrar: kapalı" }[S.repeat || 0];
    toast(nxt);
    setTimeout(poll, 100);
  });
  $("#c-shuf").addEventListener("click", () => {
    if (queue.length - (S.index + 1) < 2) { toast("karıştıracak kadar şarkı yok"); return; }
    FM.shuffleUpcoming();
    toast("⤮ sıradakiler karıştırıldı");
    setTimeout(poll, 150);
  });

  // --- SIRA ------------------------------------------------------------------------------------

  function renderQueue() {
    const el = $("#queue");
    $("#q-count").textContent = queue.length + " şarkı";
    if (!queue.length) {
      el.innerHTML = '<div class="empty-box">sıra boş</div>';
      lastIndex = -2;
      return;
    }
    const cur = S.index;
    let h = "";
    queue.forEach((s, i) => {
      const off = !S.online && !s.dl;
      const cls = "row" + (i === cur ? " is-cur" : i < cur ? " is-past" : "") + (off ? " is-nope" : "");
      const meta = [];
      if (s.dl) meta.push(s.local ? '<span class="dl">◆</span>' : '<span class="dl">↓</span>');
      meta.push(esc(s.artist || "—"));
      if (s.dur) meta.push(fmt(s.dur));
      h += '<div class="' + cls + '" data-i="' + i + '">' +
        '<span class="handle">≡</span>' +
        '<span class="num">' + (i === cur ? "▶" : pad(i + 1)) + "</span>" +
        artHtml(s, false) +
        '<div class="t"><div class="nm">' + esc(s.title) + '</div><div class="ar">' + meta.join(" · ") + "</div></div>" +
        '<button class="rm" type="button" data-act="rm" aria-label="çıkar">✕</button></div>';
    });
    el.innerHTML = h;
    lastIndex = cur;
  }

  /** Sadece çalan şarkı değiştiyse: listeyi baştan çizmeden sınıfları güncelle. */
  function markQueue() {
    if (lastIndex === S.index) return;
    lastIndex = S.index;
    $$("#queue .row").forEach((r) => {
      const i = Number(r.dataset.i);
      r.classList.toggle("is-cur", i === S.index);
      r.classList.toggle("is-past", i < S.index);
      $(".num", r).textContent = i === S.index ? "▶" : pad(i + 1);
    });
  }

  attachSwipe($("#queue"), "↳ SIRADAKİ YAP", (row) => {
    const i = Number(row.dataset.i);
    const to = S.index + 1;
    if (i === S.index || i === to) { toast("zaten sırada"); return; }
    FM.move(i, i < S.index ? S.index : to);
    queue.splice(i < S.index ? S.index : to, 0, queue.splice(i, 1)[0]);
    if (i < S.index) S.index--;
    renderQueue();
    toast("↳ sıradaki");
  });
  $("#queue").addEventListener("click", (e) => {
    if (Date.now() - ($("#queue")._swipeAt || 0) < 350) return;
    const row = e.target.closest(".row");
    if (!row || e.target.closest(".handle")) return;
    const i = Number(row.dataset.i);
    if (e.target.closest("[data-act=rm]")) {
      const s = queue[i];
      FM.remove(i);
      queue.splice(i, 1);
      if (i < S.index) S.index--;
      renderQueue();
      toast("✕ çıkarıldı: " + (s ? s.title : ""));
      return;
    }
    if (i === S.index) { FM.toggle(); return; }
    FM.jump(i);
    setTimeout(poll, 100);
  });
  makeDraggable($("#queue"), (from, to) => {
    FM.move(from, to);
    // İyimser: hemen yerinde göster, sonra Kotlin'den gelen ile tazelenir.
    queue.splice(to, 0, queue.splice(from, 1)[0]);
    if (S.index === from) S.index = to;
    else if (from < S.index && to >= S.index) S.index--;
    else if (from > S.index && to <= S.index) S.index++;
    renderQueue();
  });

  $("#q-clear").addEventListener("click", () => {
    if (!queue.length) return;
    const upcoming = queue.length - (S.index + 1);
    menu({
      title: "SIRAYI TEMİZLE",
      items: [
        upcoming > 0 && { g: "⇣", t: "Sadece sıradakileri sil", sub: upcoming + " şarkı", fn: () => { FM.clearUpcoming(); toast("sıradakiler silindi"); } },
        { g: "✕", t: "Tüm sırayı sil", danger: true, fn: () => { FM.clearQueue(); toast("sıra temizlendi"); } },
      ],
    });
  });
  $("#q-save").addEventListener("click", () => {
    if (!queue.length) { toast("sıra boş"); return; }
    ask("SIRAYI LİSTE OLARAK KAYDET", "sıra " + new Date().toLocaleDateString("tr-TR"), (name) => {
      FM.saveQueue(name);
      toast("≡ kaydedildi: " + name);
    });
  });

  // --- mini çalar -------------------------------------------------------------------------------

  let miniId = null;
  function renderMini() {
    const m = $("#mini");
    const c = S.cur;
    const wasHidden = m.hidden;
    m.hidden = playerOpen || !c;
    if (m.hidden !== wasHidden || !renderMini.laid) { renderMini.laid = true; layoutChrome(); }
    if (m.hidden) return;
    if (c.id !== miniId) {
      miniId = c.id;
      $("#mini-art").outerHTML = artHtml(c, false).replace('<div class="art">', '<div class="art" id="mini-art">');
      $("#mini-title").textContent = c.title;
      $("#mini-artist").textContent = c.artist || "—";
    }
    const playing = S.want && S.state !== 4;
    const b = $("#mini-play");
    b.textContent = playing ? "❚❚" : "▶";
    b.classList.toggle("is-on", !!S.playing);
    $("#mini-prog").style.width = S.dur ? ((S.pos / S.dur) * 100).toFixed(2) + "%" : "0";
  }
  $("#mini").addEventListener("click", (e) => {
    if (e.target.closest("#mini-play")) { FM.toggle(); setTimeout(poll, 100); return; }
    if (e.target.closest("#mini-next")) { FM.next(); setTimeout(poll, 100); return; }
    openPlayer();
  });

  // --- ANA SAYFA -------------------------------------------------------------------------------------

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* yok */ } },
  };
  let ytHome = J(store.get("fm.home"), null); // {at, acct, data:[{title, strap, rows, items}]}
  let homeBusy = false;
  let homeItems = [];

  /** YT Music ana sayfası (girişliyse sana özel). 20 dk'da bir tazelenir. */
  function loadHome(force) {
    if (!S.online || homeBusy) return;
    const fresh = ytHome && Date.now() - ytHome.at < 20 * 60e3 && ytHome.acct === !!acct.loggedIn;
    if (!force && fresh) return;
    homeBusy = true;
    if (!ytHome || force) spinner($("#home-spin"), true);
    call("home").then((d) => {
      ytHome = { at: Date.now(), acct: !!acct.loggedIn, data: d || [] };
      store.set("fm.home", JSON.stringify(ytHome));
      if (tab === "home") renderHome();
    }).catch((e) => {
      if (force) toast("ana sayfa alınamadı: " + e.message, true);
    }).finally(() => {
      homeBusy = false;
      spinner($("#home-spin"), false);
    });
  }

  function itemArt(it) {
    let src = "";
    if (it.kind === "pl") src = coverUrl(it);
    else if (it.kind === "list") src = it.thumb || "";
    else src = it.known ? "https://fm.art/" + encodeURIComponent(it.id) : (it.thumb || "");
    return '<div class="art">' + (src ? '<img loading="lazy" src="' + esc(src) + '" onerror="this.remove()" alt="">' : "") + "</div>";
  }

  function renderHome() {
    const el = $("#home");
    const byId = new Map(lib.map((x) => [x.id, x]));
    const known = (x) => (byId.has(x.id) ? Object.assign({}, x, byId.get(x.id), { kind: "song", known: true }) : x);
    const now = Date.now();
    const played = lib.filter((x) => x.playedAt > 0);
    const recent = played.slice().sort((a, b) => b.playedAt - a.playedAt).slice(0, 20);
    const top = played.slice().sort((a, b) => (b.plays || 0) - (a.plays || 0) || b.playedAt - a.playedAt).slice(0, 27);
    const forgotten = lib.filter((x) => (x.liked || (x.plays || 0) >= 3) && (!x.playedAt || now - x.playedAt > 14 * 864e5))
      .sort((a, b) => (b.plays || 0) - (a.plays || 0)).slice(0, 20);
    const fresh = lib.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 20);
    const pls = J(FM.playlists(), []);
    const yt = (S.online && ytHome && ytHome.data) || [];
    const mine = (arr) => arr.map((x) => Object.assign({}, x, { kind: "song", known: true }));

    const secs = [];
    if (!yt.length && top.length) secs.push({ title: "Hızlı seçim", strap: "en çok dinlediklerin", style: "grid", items: mine(top), src: "TELEFON" });
    yt.forEach((sec, i) => secs.push({
      title: sec.title, strap: sec.strap,
      style: sec.rows ? "rows" : (i === 0 && sec.items.length >= 6 ? "grid" : "cards"),
      items: sec.items.map((x) => (x.kind === "song" ? known(x) : x)), src: "YT",
    }));
    if (recent.length) secs.push({ title: "Son dinlenenler", strap: "bu telefonda", style: "cards", items: mine(recent), src: "TELEFON" });
    if (forgotten.length) secs.push({ title: "Unutulan favoriler", strap: "bir süredir çalmadın", style: "cards", items: mine(forgotten), src: "TELEFON" });
    if (pls.length) secs.push({
      title: "Listelerin", style: "cards", src: "TELEFON",
      items: pls.map((p) => ({ kind: "pl", id: p.id, title: p.name, artist: p.count + " şarkı" + (p.yt ? " · YT" : ""), coverV: p.coverV })),
    });
    if (yt.length && top.length) secs.push({ title: "Çok dinlediklerin", style: "grid", items: mine(top), src: "TELEFON" });
    if (fresh.length) secs.push({ title: "Yeni eklenenler", style: "cards", items: mine(fresh), src: "TELEFON" });

    // Yeniden çizerken kaydırma yerleri kaybolmasın.
    const keep = {};
    $$(".hscroll", el).forEach((h) => { keep[h.dataset.sec] = h.scrollLeft; });

    homeItems = [];
    if (!secs.length) {
      el.innerHTML = '<div class="panel home-empty"><div class="panel-head"><h2>HOŞ GELDİN</h2></div>' +
        '<p class="panel-desc">Henüz dinlediğin bir şey yok. YouTube Music hesabınla giriş yaparsan sana özel ana sayfa ve listelerin gelir; ' +
        "ya da ARA'dan şarkı bul, telefondaki müzikleri tara.</p>" +
        '<div class="row-btns"><button class="btn btn-solid" type="button" id="he-login">◉ GİRİŞ YAP</button>' +
        '<button class="btn" type="button" data-go="search">⌕ ARA</button>' +
        '<button class="btn btn-ghost" type="button" id="he-scan">◆ TELEFONU TARA</button></div></div>';
      const lg = $("#he-login");
      if (acct.loggedIn) lg.remove(); else lg.addEventListener("click", () => $("#acct-login").click());
      $("#he-scan").addEventListener("click", () => $("#scan").click());
      return;
    }
    const cur = S.cur && S.cur.id;
    el.innerHTML = secs.map((sec, si) => {
      const key = sec.src + ":" + sec.title;
      const cells = sec.items.map((it) => {
        const h = homeItems.push(it) - 1;
        const nope = it.kind === "song" && !S.online && !it.dl ? " is-nope" : "";
        const isCur = it.kind === "song" && it.id === cur ? " is-cur" : "";
        if (sec.style === "rows") return songRow(it, h, { remote: !it.known }).replace('data-k="', 'data-h="');
        if (sec.style === "grid") {
          return '<button type="button" class="tile' + nope + isCur + '" data-h="' + h + '">' + itemArt(it) +
            '<span class="lbl">' + esc(it.title) + "</span></button>";
        }
        return '<button type="button" class="card' + (it.kind !== "song" ? " is-list" : "") + nope + isCur + '" data-h="' + h + '">' + itemArt(it) +
          '<div class="nm">' + esc(it.title) + '</div><div class="ar">' + esc(it.artist || "") + "</div></button>";
      }).join("");
      return '<section class="hs"><div class="hs-head"><div class="tt">' + (sec.strap ? '<div class="st">' + esc(sec.strap) + "</div>" : "") +
        "<h2>" + esc(sec.title) + '</h2></div><span class="src">' + sec.src + "</span></div>" +
        '<div class="hscroll hs-' + sec.style + '" data-sec="' + esc(key) + '">' + cells + "</div></section>";
    }).join("");
    $$(".hscroll", el).forEach((h) => { if (keep[h.dataset.sec]) h.scrollLeft = keep[h.dataset.sec]; });
  }
  bindSongList($("#home"), () => homeItems, () => ({ kind: "home" }), "[data-h]", "h");

  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-chip]");
    if (!b) return;
    const c = b.dataset.chip;
    if (c === "shuffle") {
      const pool = S.online ? lib : lib.filter((x) => x.dl);
      if (pool.length) enqueue(pool, "shuffle"); else toast("kitaplık boş — ARA'dan şarkı ekle");
    } else if (c === "dl") {
      libMode = "dl"; libLimit = LIB_LIMIT; go("lib");
    } else if (c === "liked") {
      const lm = J(FM.playlists(), []).find((p) => p.src === "yt:LM");
      if (lm) { openPlaylist(lm.id); return; }
      const liked = lib.filter((x) => x.liked);
      if (liked.length) openSheet({ kind: "virt", name: "Beğenilenler", songs: liked }); else toast("beğenilen yok");
    } else if (c === "local") {
      const loc = lib.filter((x) => x.local);
      if (loc.length) enqueue(loc, "shuffle"); else toast("yerel şarkı yok");
    } else if (c === "refresh") {
      if (!S.online) { toast("internet yok", true); return; }
      loadHome(true);
      renderHome();
    }
  });

  // --- KİTAPLIK ------------------------------------------------------------------------------------

  const LIB_MODES = [["lists", "LİSTELER"], ["dl", "İNDİRİLENLER"]];
  const dlOpen = new Set();
  let libMode = "lists";
  let libShown = [];
  let lists = [];
  const LIB_LIMIT = 400;
  let libLimit = LIB_LIMIT;

  function libFiltered() {
    const q = norm($("#lib-q").value.trim());
    let arr = lib;
    if (libMode === "dl") arr = arr.filter((s) => s.dl);
    else if (libMode === "liked") arr = arr.filter((s) => s.liked);
    if (q) arr = arr.filter((s) => norm(s.title + " " + s.artist).includes(q));
    return arr;
  }

  /** İndirilenler: her liste ayrı grup (hangi listeden indirildiği), en altta tümü. */
  function renderDlGroups(el) {
    const pls = J(FM.playlists(), []);
    const all = lib.filter((s) => s.dl);
    const byId = new Map(all.map((s) => [s.id, s]));
    const groups = pls.map((p) => ({ key: p.id, p, songs: (p.ids || []).map((id) => byId.get(id)).filter(Boolean) }))
      .filter((g) => g.songs.length);
    groups.push({ key: "__all", all: true, songs: all });
    $("#lib-sec").innerHTML = "<b>↓</b> " + all.length + " şarkı · " + (groups.length - 1) + " liste";
    if (!all.length) { el.innerHTML = '<div class="empty-box">indirilen yok</div>'; libShown = []; return; }
    libShown = [];
    libGroups = groups;
    el.innerHTML = groups.map((g, gi) => {
      const open = dlOpen.has(g.key);
      const start = libShown.length;
      if (open) libShown.push(...g.songs);
      const head = '<button type="button" class="dl-head" data-g="' + gi + '">' +
        (g.all ? '<div class="art"></div>' : coverHtml(g.p)) +
        '<div class="t"><div class="nm">' + (g.all ? "TÜM İNDİRİLENLER" : esc(g.p.name)) + '</div><div class="ar">' +
        (g.all ? g.songs.length + " şarkı" : "<b>" + g.songs.length + "</b> / " + g.p.count + " indirili") + "</div></div>" +
        '<span class="pl" data-gplay="' + gi + '">▶</span><span class="chev">›</span></button>';
      const rows = open ? '<div class="dl-songs">' + g.songs.map((s, i) => songRow(s, start + i)).join("") + "</div>" : "";
      return '<div class="dl-group' + (open ? " is-open" : "") + (g.all ? " is-all" : "") + '">' + head + rows + "</div>";
    }).join("");
  }
  let libGroups = [];

  function renderLib() {
    $("#lib-mode-name").textContent = (LIB_MODES.find((m) => m[0] === libMode) || LIB_MODES[0])[1];
    const isLists = libMode === "lists";
    $("#lib-bar").hidden = isLists || (libMode === "dl" && !$("#lib-q").value.trim());
    $("#lib-q").placeholder = isLists ? "listelerde ara" : "şarkı ara (internetsiz çalışır)";
    const el = $("#lib-list");

    if (isLists) {
      lists = J(FM.playlists(), []);
      const q = norm($("#lib-q").value.trim());
      const shown = q ? lists.filter((p) => norm(p.name).includes(q)) : lists;
      $("#lib-sec").innerHTML = "<b>≡</b> " + lists.length + " liste";
      if (!shown.length) {
        el.innerHTML = '<div class="empty-box">' + (lists.length ? "eşleşen liste yok" : "liste yok") + "</div>";
        return;
      }
      el.innerHTML = shown.map((p) =>
        '<div class="row pl-row" data-pl="' + esc(p.id) + '">' +
        coverHtml(p) +
        '<div class="t"><div class="nm">' + esc(p.name) + '</div><div class="ar">' + (p.yt ? '<span class="yt-tag">YT</span> · ' : "") + p.count + " şarkı · " +
        (p.dl === p.count && p.count ? '<span class="dl">↓ hepsi indirili</span>' : p.dl + " indirili") + "</div></div>" +
        '<button class="more" type="button" data-act="plmore">⋯</button></div>').join("");
      return;
    }

    if (libMode === "dl" && !$("#lib-q").value.trim()) { renderDlGroups(el); return; }
    libShown = libFiltered();
    const dl = lib.filter((s) => s.dl).length;
    $("#lib-sec").innerHTML = "<b>♪</b> " + libShown.length + " şarkı" + (libMode === "all" ? " · " + dl + " internetsiz çalar" : "");
    if (!libShown.length) {
      const msg = $("#lib-q").value ? "eşleşen şarkı yok" : {
        dl: "indirilen yok",
        all: "kitaplık boş",
        liked: "beğenilen yok",
      }[libMode];
      el.innerHTML = '<div class="empty-box">' + msg + "</div>";
      return;
    }
    const part = libShown.slice(0, libLimit);
    el.innerHTML = part.map((s, k) => songRow(s, k)).join("") +
      (libShown.length > part.length ? '<button class="btn btn-ghost" style="margin:1rem auto" type="button" id="lib-more">+ ' + (libShown.length - part.length) + " DAHA</button>" : "");
  }

  // Görünüm düğmesi: dokun → sonraki (LİSTELER → İNDİRİLENLER → BEĞENİLENLER → TÜM ŞARKILAR).
  $("#lib-mode").addEventListener("click", () => {
    const i = LIB_MODES.findIndex((m) => m[0] === libMode);
    libMode = LIB_MODES[(i + 1) % LIB_MODES.length][0];
    libLimit = LIB_LIMIT;
    $("#lib-list").scrollTop = 0;
    replay($("#lib-list"), "a-sw");
    renderLib();
  });
  $("#lib-find").addEventListener("click", () => {
    const box = $("#lib-search");
    box.hidden = !box.hidden;
    $("#lib-find").setAttribute("aria-pressed", String(!box.hidden));
    if (box.hidden) { $("#lib-q").value = ""; renderLib(); } else $("#lib-q").focus();
  });
  $("#lib-new").addEventListener("click", () => menu({
    title: "EKLE",
    items: [
      { g: "≡", t: "Yeni liste", fn: () => ask("YENİ LİSTE", "", (name) => { FM.createPlaylist(name, "[]"); toast("≡ oluşturuldu: " + name); libMode = "lists"; renderLib(); }) },
      { g: "⇣", t: "YouTube linkinden al", fn: () => ask("YOUTUBE / YT MUSIC LİNKİ", "", (url) => importLink(url), { placeholder: "https://music.youtube.com/playlist?list=…", ok: "AL" }) },
      acct.loggedIn && { g: "↻", t: "YouTube kitaplığını eşitle", fn: syncAccount },
      { g: "◆", t: "Telefondaki müzikleri tara", fn: () => $("#scan").click() },
    ],
  }));
  $("#lib-q").addEventListener("input", () => { libLimit = LIB_LIMIT; renderLib(); });
  $("#lib-q-x").addEventListener("click", (e) => { e.preventDefault(); $("#lib-find").click(); });
  bindSongList($("#lib-list"), () => libShown, () => ({ kind: "lib" }));
  $("#lib-list").addEventListener("click", (e) => {
    if (e.target.closest("#lib-more")) { libLimit += LIB_LIMIT; renderLib(); return; }
    const gp = e.target.closest("[data-gplay]");
    if (gp) { const g = libGroups[Number(gp.dataset.gplay)]; if (g) enqueue(g.songs, "replace"); return; }
    const gh = e.target.closest("[data-g]");
    if (gh) {
      const g = libGroups[Number(gh.dataset.g)];
      if (!g) return;
      if (dlOpen.has(g.key)) dlOpen.delete(g.key); else dlOpen.add(g.key);
      renderLib();
      return;
    }
    const pl = e.target.closest("[data-pl]");
    if (!pl) return;
    if (e.target.closest("[data-act=plmore]")) { openListMenu(pl.dataset.pl); return; }
    openPlaylist(pl.dataset.pl);
  });
  $("#lib-play").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "replace"); else toast("liste boş"); });
  $("#lib-shuf").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "shuffle"); else toast("liste boş"); });
  $("#lib-add").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "end"); else toast("liste boş"); });
  // --- liste ayrıntısı (sheet) ---------------------------------------------------------------------

  /** sh = { kind: "pl" | "yt", id?, url?, name, songs } */
  let sh = null;

  function openSheet(data) {
    sh = data;
    if ($("#sheet").hidden || $("#sheet").classList.contains("a-out")) showOver($("#sheet"));
    $("#sheet-body").scrollTop = 0;
    renderSheet();
  }
  function closeSheet() {
    hideOver($("#sheet"));
    sh = null;
    spinner($("#sheet-spin"), false);
  }
  function renderSheet() {
    if (!sh) return;
    $("#sheet-title").textContent = sh.kind === "artist" ? "SANATÇI" : "LİSTE";
    const songs = sh.songs || [];
    const hero = $("#sheet-hero");
    if (sh.loading && !sh.name) hero.innerHTML = "";
    else {
      const img = sh.kind === "pl" ? coverHtml(sh)
        : '<div class="art">' + (sh.thumb ? '<img src="' + esc(sh.thumb) + '" onerror="this.remove()" alt="">' : "") + "</div>";
      const sub = sh.kind === "artist" ? "sanatçı" : sh.kind === "pl" ? (sh.yt ? "YouTube" : "liste") : sh.kind === "virt" ? "beğenilenler" : "YouTube";
      const btns = (sh.kind === "pl" ? '<button class="btn btn-ghost" type="button" data-hero="cover">▣ KAPAK</button>' : "") +
        (sh.kind === "artist" && sh.allId ? '<button class="btn btn-ghost" type="button" data-hero="all">TÜM ŞARKILAR →</button>' : "");
      hero.innerHTML = img + '<div class="t"><div class="nm">' + esc(sh.name || "") + '</div><div class="ar">' + sub + "</div>" + btns + "</div>";
    }
    const dl = songs.filter((s) => s.dl).length;
    $("#sheet-sec").innerHTML = sh.loading ? "" : "<b>♪</b> " + songs.length + " şarkı · " + dl + " indirili" + (sh.kind === "yt" ? " · YouTube'dan" : "");
    $("#sheet-bar").hidden = !!sh.loading;
    const el = $("#sheet-list");
    if (sh.loading) { el.innerHTML = ""; return; }
    if (!songs.length) {
      if (!(sh.lists || []).length) {
        el.innerHTML = '<div class="empty-box">' + (sh.kind === "pl" ? "liste boş" : "şarkı bulunamadı") + "</div>";
        return;
      }
    }
    const ls = sh.lists || [];
    const up = (t, d) => esc((t || d).toLocaleUpperCase("tr"));
    el.innerHTML = (sh.kind === "artist" && songs.length ? '<div class="sec" style="padding:.4rem 0 .3rem"><b>♪</b> ' + up(sh.songsTitle, "Popüler şarkılar") + "</div>" : "") +
      songs.map((s, k) => songRow(s, k, { handle: sh.kind === "pl", remote: sh.kind !== "pl" && !s.dl })).join("") +
      (ls.length ? '<div class="sec" style="padding:1.2rem 0 .3rem"><b>≡</b> ' + up(sh.listsTitle, "Albümler · Tekliler") + "</div>" + ls.map((r, i) =>
        '<div class="row pl-row" data-k="' + (songs.length + i) + '">' + artHtml(r, true) +
        '<div class="t"><div class="nm">' + esc(r.title) + '</div><div class="ar">' + esc(r.artist || "") + "</div></div>" +
        '<span class="more">→</span></div>').join("") : "") +
      (sh.kind === "pl" && S.online ? '<div class="sugg-head"><div class="sec"><b>≈</b> ÖNERİLEN</div><button class="btn btn-ghost" type="button" data-sugg="more">↻</button></div>' +
        '<div class="sugg">' + (sh.sugg || []).map((s, i) => songRow(s, songs.length + ls.length + i, { remote: !s.dl })).join("") +
        (sh.sugg && !sh.sugg.length ? '<div class="empty-box">öneri yok</div>' : "") + "</div>" : "");
    if (sh.kind === "pl" && S.online && !sh.sugg && !sh.suggBusy) loadPlSugg();
  }
  /** Listenin şarkılarından rastgele birkaçına benzer şarkılar. */
  function loadPlSugg() {
    const cur = sh;
    if (!cur) return;
    cur.suggBusy = true;
    const pool = cur.songs.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
    suggest(pool, cur.songs.map((s) => s.id).concat((cur.sugg || []).map((s) => s.id)), 20).then((items) => {
      cur.sugg = items;
      if (sh === cur) renderSheet();
    }).finally(() => { cur.suggBusy = false; });
  }
  $("#sheet-list").addEventListener("click", (e) => {
    if (!e.target.closest("[data-sugg]") || !sh) return;
    if (!S.online) { toast("internet yok", true); return; }
    sh.sugg = null;
    renderSheet();
  });
  function openPlaylist(id) {
    const p = J(FM.playlist(id), null);
    if (!p) { toast("liste bulunamadı", true); return; }
    openSheet({ kind: "pl", id: p.id, name: p.name, songs: p.songs, coverV: p.coverV, yt: p.yt });
  }
  function reloadSheet() {
    if (sh && sh.kind === "pl") {
      const p = J(FM.playlist(sh.id), null);
      if (!p) { closeSheet(); return; }
      sh.name = p.name; sh.songs = p.songs; sh.coverV = p.coverV;
      renderSheet();
    } else if (sh && sh.kind !== "pl" && sh.songs) {
      // İndirme durumu değişmiş olabilir.
      const byId = new Map(lib.map((s) => [s.id, s]));
      sh.songs = sh.songs.map((s) => byId.get(s.id) || s);
      renderSheet();
    }
  }
  /** YouTube listesi / albüm / karışık: kimlik (PL…, OLAK…, RD…) ya da adres. */
  function openArtist(id, name, thumb) {
    if (!S.online) { toast("internet yok", true); return; }
    const ref = "artist:" + id;
    openSheet({ kind: "artist", url: ref, name: name || "", thumb: thumb || "", loading: true, songs: [], lists: [] });
    spinner($("#sheet-spin"), true);
    call("artist", id).then((d) => {
      if (!sh || sh.url !== ref) return;
      spinner($("#sheet-spin"), false);
      Object.assign(sh, { loading: false, name: d.name || name, thumb: d.thumb || thumb, songs: d.songs || [], lists: d.lists || [], allId: d.all || null, songsTitle: d.songsTitle || "", listsTitle: d.listsTitle || "" });
      renderSheet();
    }).catch((e) => {
      spinner($("#sheet-spin"), false);
      if (sh && sh.url === ref) { sh.loading = false; renderSheet(); }
      toast("sanatçı açılamadı: " + e.message, true);
    });
  }

  function openYtList(ref, name, thumb) {
    if (!S.online) { toast("internet yok", true); return; }
    const m = /[?&]list=([\w-]+)/.exec(ref || "");
    const id = m ? m[1] : (/^[\w-]+$/.test(ref || "") ? ref : null);
    openSheet({ kind: "yt", url: ref, name: name || "LİSTE", thumb: thumb || "", loading: true, songs: [] });
    spinner($("#sheet-spin"), true);
    (id ? call("openYt", id) : call("openList", ref)).then((d) => {
      if (!sh || sh.url !== ref) return;
      spinner($("#sheet-spin"), false);
      sh.loading = false; sh.name = name || d.name; sh.songs = d.songs || [];
      renderSheet();
    }).catch((e) => {
      spinner($("#sheet-spin"), false);
      if (sh && sh.url === ref) { sh.loading = false; renderSheet(); }
      toast("liste açılamadı: " + e.message, true);
    });
  }
  function importLink(url) {
    url = (url || "").trim();
    if (!url) return;
    if (!S.online) { toast("internet yok", true); return; }
    openSheet({ kind: "yt", url, name: "YÜKLENİYOR", loading: true, songs: [] });
    spinner($("#sheet-spin"), true);
    call("importLink", url).then((d) => {
      spinner($("#sheet-spin"), false);
      if (!sh || sh.url !== url) return;
      sh.loading = false; sh.name = d.name; sh.songs = d.songs || [];
      renderSheet();
    }).catch((e) => {
      spinner($("#sheet-spin"), false);
      closeSheet();
      toast("link açılamadı: " + e.message, true);
    });
  }

  $("#sheet-back").addEventListener("click", closeSheet);
  bindSongList($("#sheet-list"), () => (sh ? sh.songs.concat(sh.lists || [], sh.sugg || []) : []), () => (sh ? {
    kind: sh.kind, pid: sh.id,
    onAdd: (it) => {
      // Öneriden ＋ → bu listeye ekle; listedeki şarkıda ＋ → sıraya.
      if (sh.kind === "pl" && sh.sugg && sh.sugg.includes(it)) {
        FM.addToPlaylist(sh.id, JSON.stringify([it]));
        sh.sugg = sh.sugg.filter((x) => x !== it);
        toast("≡ listeye eklendi");
        reloadSheet();
      } else enqueue([it], "end");
    },
  } : {}));
  $("#sheet-hero").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hero]");
    if (!b || !sh) return;
    if (b.dataset.hero === "cover") coverMenu(sh.id);
    if (b.dataset.hero === "all") openYtList(sh.allId, sh.name + " · tüm şarkılar");
  });
  makeDraggable($("#sheet-list"), (from, to) => {
    if (!sh || sh.kind !== "pl") return;
    FM.plMove(sh.id, from, to);
    sh.songs.splice(to, 0, sh.songs.splice(from, 1)[0]);
    renderSheet();
  });
  $("#sh-play").addEventListener("click", () => sh && enqueue(sh.songs, "replace"));
  $("#sh-shuf").addEventListener("click", () => sh && enqueue(sh.songs, "shuffle"));
  $("#sh-add").addEventListener("click", () => sh && enqueue(sh.songs, "end"));
  $("#sh-dl").addEventListener("click", () => {
    if (!sh) return;
    const n = FM.download(JSON.stringify(sh.songs.filter((s) => !s.dl)));
    toast(n ? "↓ " + n + " şarkı indiriliyor" : "hepsi zaten indirili");
  });
  $("#sheet-more").addEventListener("click", () => {
    if (!sh) return;
    if (sh.kind === "pl") { openListMenu(sh.id); return; }
    menu({
      title: sh.name,
      items: [
        { g: "≡", t: "Liste olarak kaydet", fn: () => saveYtList() },
        { g: "↓", t: "Kaydet ve hepsini indir", fn: () => saveYtList(true) },
      ],
    });
  });
  function saveYtList(download) {
    if (!sh || !sh.songs.length) return;
    const id = FM.createPlaylist(sh.name || "liste", JSON.stringify(sh.songs));
    if (download) FM.download(JSON.stringify(sh.songs));
    toast("≡ kaydedildi" + (download ? " · indiriliyor" : ""));
    openPlaylist(id);
  }

  function coverMenu(pid) {
    const p = J(FM.playlist(pid), null);
    if (!p) return;
    menu({
      title: "KAPAK", sub: p.name,
      items: [
        { g: "▣", t: "Galeriden resim seç", fn: () => { FM.pickCover(pid); toast("resim seç"); } },
        p.custom && { g: "✕", t: "Kendi kapağımı kaldır", fn: () => { FM.removeCover(pid); toast("kapak kaldırıldı"); } },
      ],
    });
  }

  function openListMenu(pid) {
    const p = J(FM.playlist(pid), null);
    if (!p) return;
    menu({
      title: p.name,
      sub: p.songs.length + " şarkı",
      items: [
        { g: "▶", t: "Çal", fn: () => enqueue(p.songs, "replace") },
        { g: "⤮", t: "Karışık çal", fn: () => enqueue(p.songs, "shuffle") },
        { g: "↳", t: "Sıradaki olarak ekle", fn: () => enqueue(p.songs, "next") },
        { g: "＋", t: "Sıranın sonuna ekle", fn: () => enqueue(p.songs, "end") },
        { g: "↓", t: "Hepsini indir", fn: () => { const n = FM.download(JSON.stringify(p.songs)); toast(n ? "↓ " + n + " şarkı indiriliyor" : "hepsi zaten indirili"); } },
        p.yt && { g: "↻", t: "YouTube'dan tazele", fn: () => {
          if (!S.online) { toast("internet yok", true); return; }
          toast("↻ tazeleniyor…");
          call("syncList", pid).then((d) => { toast("↻ " + d.songs + " şarkı"); reloadSheet(); }).catch((e) => toast(e.message, true));
        } },
        { g: "▣", t: "Kapak resmi", fn: () => coverMenu(pid) },
        { g: "✎", t: "Yeniden adlandır", fn: () => ask("LİSTEYİ YENİDEN ADLANDIR", p.name, (name) => { FM.plRename(pid, name); reloadSheet(); renderLib(); }) },
        { g: "✕", t: "Listeyi sil", danger: true, fn: () => confirmDo("“" + p.name + "” silinsin mi? Şarkılar kitaplıkta kalır.", () => { FM.plDelete(pid); if (sh && sh.id === pid) closeSheet(); renderLib(); toast("liste silindi"); }) },
      ],
    });
  }

  // --- ARA ---------------------------------------------------------------------------------------

  let sFilter = "songs";
  let sResults = [];
  let sLastQ = "";

  function renderSearchState() {
    $("#s-offline").hidden = !!S.online;
  }
  function subs(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(".", ",") + " Mn";
    if (n >= 1e3) return Math.round(n / 1e3) + " B";
    return String(n);
  }
  function renderSearch() {
    const el = $("#s-list");
    $("#s-sec").innerHTML = sLastQ ? "<b>&gt;</b> “" + esc(sLastQ) + "” · " + sResults.length + " sonuç" : "";
    if (!sResults.length) { el.innerHTML = sLastQ ? '<div class="empty-box">sonuç yok</div>' : ""; return; }
    const byId = new Map(lib.map((s) => [s.id, s]));
    el.innerHTML = sResults.map((r, k) => {
      if (r.kind === "artist") {
        return '<div class="row pl-row" data-k="' + k + '">' + artHtml(r, true) +
          '<div class="t"><div class="nm">' + esc(r.title) + '</div><div class="ar">sanatçı' + (r.subs > 0 ? " · " + subs(r.subs) + " abone" : "") + "</div></div>" +
          '<span class="more">→</span></div>';
      }
      if (r.kind === "list") {
        return '<div class="row pl-row" data-k="' + k + '">' + artHtml(r, true) +
          '<div class="t"><div class="nm">' + esc(r.title) + '</div><div class="ar">' + esc(r.artist || "") + (r.count > 0 ? " · " + r.count + " şarkı" : "") + "</div></div>" +
          '<span class="more">→</span></div>';
      }
      const known = byId.get(r.id);
      return songRow(known ? Object.assign({}, r, { dl: known.dl, liked: known.liked }) : r, k, { remote: true });
    }).join("");
  }
  function doSearch(auto) {
    const q = $("#s-q").value.trim();
    if (!q) return;
    if (auto && q === sLastQ && sFilter === sLastF) return;
    if (!auto) $("#s-q").blur();
    if (/^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\//i.test(q)) { importLink(q); return; }
    if (!S.online) { renderSearchState(); toast("internet yok", true); return; }
    sLastQ = q;
    const f = sFilter;
    sLastF = f;
    sResults = [];
    renderSearch();
    $("#s-sec").innerHTML = "";
    spinner($("#s-spin"), true);
    call("search", q, f).then((arr) => {
      if (q !== sLastQ || f !== sFilter) return;
      sResults = arr || [];
      spinner($("#s-spin"), false);
      renderSearch();
    }).catch((e) => {
      spinner($("#s-spin"), false);
      toast("arama başarısız: " + e.message, true);
      renderSearch();
    });
  }
  $("#s-form").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(sTimer); doSearch(); });
  let sTimer = 0, sLastF = "";
  $("#s-q").addEventListener("input", () => {
    clearTimeout(sTimer);
    const q = $("#s-q").value.trim();
    // Link yapıştırılınca beklemeden aç; yazarken 0,6 sn durunca ara.
    if (/^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\//i.test(q)) return;
    if (q.length < 2) return;
    sTimer = setTimeout(() => doSearch(true), 600);
  });
  $$("#s-filter button").forEach((b) => b.addEventListener("click", () => {
    sFilter = b.dataset.f;
    $$("#s-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if ($("#s-q").value.trim()) doSearch();
  }));
  bindSongList($("#s-list"), () => sResults, () => ({ kind: "search" }));

  // --- şarkı menüsü --------------------------------------------------------------------------------

  function closeMenu() {
    $$(".scrim:not(.a-out)").forEach((m) => {
      const t = ams("menu");
      if (!t) { m.remove(); return; }
      m.classList.add("a-out");
      setTimeout(() => m.remove(), t);
    });
  }
  function closeModal(m) {
    if (!m || m.classList.contains("a-out")) return;
    const t = ams("modal");
    if (!t) { m.remove(); return; }
    m.classList.add("a-out");
    setTimeout(() => m.remove(), t);
  }

  /** m = { title, sub, song, items:[{g, t, sub, danger, fn}] } */
  function menu(m) {
    closeMenu();
    const sc = document.createElement("div");
    sc.className = "scrim";
    const items = m.items.filter(Boolean);
    sc.innerHTML = '<div class="menu">' +
      '<div class="menu-head">' + (m.song ? artHtml(m.song, m.remote) : "") +
      '<div class="t"><div class="nm">' + esc(m.title) + '</div><div class="ar">' + esc(m.sub || "") + "</div></div></div>" +
      items.map((it, i) => '<button class="it' + (it.danger ? " danger" : "") + '" type="button" data-i="' + i + '"><span class="g">' + it.g + "</span>" + esc(it.t) + (it.sub ? "<small>" + esc(it.sub) + "</small>" : "") + "</button>").join("") +
      "</div>";
    sc.addEventListener("click", (e) => {
      const b = e.target.closest("button.it");
      if (b) { closeMenu(); items[Number(b.dataset.i)].fn(); setTimeout(poll, 120); return; }
      if (e.target === sc) closeMenu();
    });
    document.body.appendChild(sc);
  }

  function openSongMenu(s, ctx) {
    const known = lib.find((x) => x.id === s.id);
    const song = known ? Object.assign({}, s, known) : s;
    const items = [
      { g: "▶", t: "Şimdi çal", fn: () => enqueue([song], "now") },
      { g: "↳", t: "Sıradaki", fn: () => enqueue([song], "next") },
      { g: "＋", t: "Sıranın sonuna ekle", fn: () => enqueue([song], "end") },
    ];
    if (ctx && ctx.items && ctx.items.length > 1 && ctx.kind !== "search") {
      items.push({ g: "⏵", t: "Buradan itibaren çal", fn: () => enqueue(ctx.items, "replace", ctx.k) });
    }
    if (!song.local) {
      if (song.dl) items.push({ g: "✕", t: "İndirmeyi sil", fn: () => { FM.deleteDownload(song.id); toast("indirme silindi"); } });
      else items.push({ g: "↓", t: "İndir", fn: () => { const n = FM.download(JSON.stringify([song])); toast(n ? "↓ indiriliyor" : "zaten indiriliyor"); } });
    }
    items.push({ g: song.liked ? "♡" : "♥", t: song.liked ? "Beğeniyi kaldır" : "Beğen", fn: () => {
      FM.remember(JSON.stringify([song]));
      FM.like(song.id, !song.liked);
      toast(song.liked ? "beğeni kaldırıldı" : "♥ beğenildi");
    } });
    items.push({ g: "≡", t: "Listeye ekle", fn: () => pickList([song]) });
    if (ctx && ctx.kind === "pl" && ctx.pid) {
      items.push({ g: "−", t: "Listeden çıkar", danger: true, fn: () => { FM.plRemove(ctx.pid, ctx.k); reloadSheet(); toast("listeden çıkarıldı"); } });
    }
    if (known && ctx && ctx.kind === "lib") {
      items.push({ g: "✕", t: "Kitaplıktan sil", danger: true, fn: () => confirmDo("“" + song.title + "” kitaplıktan, listelerden ve indirmelerden silinsin mi?", () => { FM.forget(song.id); toast("silindi"); }) });
    }
    menu({ title: song.title, sub: song.artist, song, remote: ctx && ctx.kind === "search" && !song.dl, items });
  }

  function pickList(songs) {
    const ls = J(FM.playlists(), []);
    menu({
      title: "LİSTEYE EKLE",
      sub: songs.length > 1 ? songs.length + " şarkı" : songs[0].title,
      items: [
        { g: "＋", t: "Yeni liste…", fn: () => ask("YENİ LİSTE", "", (name) => { FM.createPlaylist(name, JSON.stringify(songs)); toast("≡ " + name + " oluşturuldu"); renderLib(); }) },
      ].concat(ls.map((p) => ({ g: "≡", t: p.name, sub: p.count + " şarkı", fn: () => { FM.addToPlaylist(p.id, JSON.stringify(songs)); toast("≡ " + p.name + " listesine eklendi"); } }))),
    });
  }

  // --- küçük pencereler ----------------------------------------------------------------------------

  function ask(title, value, done, opts) {
    const o = opts || {};
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = '<form class="modal-box"><h3>' + esc(title) + '</h3><input type="text" spellcheck="false" autocomplete="off" placeholder="' + esc(o.placeholder || "isim") + '" />' +
      '<div class="row-btns"><button class="btn btn-ghost" type="button" data-x>VAZGEÇ</button><button class="btn btn-solid" type="submit">' + esc(o.ok || "TAMAM") + "</button></div></form>";
    const inp = $("input", m);
    inp.value = value || "";
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-x]")) closeModal(m); });
    $("form", m).addEventListener("submit", (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      closeModal(m);
      done(v);
    });
    document.body.appendChild(m);
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }

  function confirmDo(text, fn) {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = '<div class="modal-box"><h3>EMİN MİSİN?</h3><p class="panel-desc" style="margin:0">' + esc(text) + '</p>' +
      '<div class="row-btns"><button class="btn btn-ghost" type="button" data-x>VAZGEÇ</button><button class="btn btn-danger" type="button" data-ok>SİL</button></div></div>';
    m.addEventListener("click", (e) => {
      if (e.target.closest("[data-ok]")) { closeModal(m); fn(); setTimeout(poll, 120); return; }
      if (e.target === m || e.target.closest("[data-x]")) closeModal(m);
    });
    document.body.appendChild(m);
  }

  // --- spinner (ULL-Bot: ■ Cooking… ░▒▓█▓▒░░ 3s) ----------------------------------------------

  const VERBS = ["Aranıyor", "Kazılıyor", "Plaklar karıştırılıyor", "Frekans ayarlanıyor", "Kasetler sarılıyor", "Dalga boyu ölçülüyor", "Ritim yakalanıyor"];
  const BOUNCE = ["▄", "■", "▀", "■"];
  const PULSE = "░▒▓█▓▒░░░░";
  const spins = new Map();

  function spinner(node, on) {
    const cur = spins.get(node);
    if (!on) {
      if (cur) { clearInterval(cur.t1); clearInterval(cur.t2); spins.delete(node); }
      node.textContent = "";
      return;
    }
    if (cur) return;
    node.innerHTML = '<span class="glyph"></span><span class="verb"></span><span class="bar"></span><span class="secs"></span>';
    const [glyph, verb, bar, secs] = node.children;
    const started = performance.now();
    let frame = 0;
    const nextVerb = () => { verb.textContent = VERBS[(Math.random() * VERBS.length) | 0] + "…"; };
    const tick = () => {
      glyph.textContent = BOUNCE[frame % BOUNCE.length];
      let s = "";
      for (let j = 0; j < 8; j++) s += PULSE[(((j - frame) % PULSE.length) + PULSE.length) % PULSE.length];
      bar.textContent = s;
      secs.textContent = Math.floor((performance.now() - started) / 1000) + "s";
      frame++;
    };
    nextVerb(); tick();
    spins.set(node, { t1: setInterval(tick, 110), t2: setInterval(nextVerb, 1800) });
  }

  // --- HESAP ------------------------------------------------------------------------------------------

  let acct = J(safe(() => FM.account(), "{}"), { loggedIn: false });
  let arev = -1;
  let syncBusy = false;

  function renderAccount() {
    $("#acct-out").hidden = !!acct.loggedIn;
    $("#acct-in").hidden = !acct.loggedIn;
    $("#acct-badge").textContent = acct.loggedIn ? "BAĞLI" : "GİRİŞ YOK";
    $("#sm-acct").textContent = acct.loggedIn ? (acct.name || "bağlı") + (acct.handle ? " · " + acct.handle : "") : "giriş yapılmadı";
    $("#acct-badge").className = "badge" + (acct.loggedIn ? " red" : "");
    $("#me").classList.toggle("is-in", !!acct.loggedIn);
    const ma = $("#me-art");
    const mp = (acct.loggedIn && acct.photo) || "";
    if (ma.dataset.src !== mp) {
      ma.dataset.src = mp;
      ma.innerHTML = mp ? '<img src="' + esc(mp) + '" onerror="this.remove()" alt="">' : "";
    }
    if (!acct.loggedIn) return;
    $("#acct-name").textContent = acct.name || "YouTube hesabı";
    const when = acct.syncedAt ? "son eşitleme " + new Date(acct.syncedAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "henüz eşitlenmedi";
    $("#acct-sub").textContent = (acct.handle ? acct.handle + " · " : "") + (S.syncing ? "eşitleniyor " + S.syncing : when);
    const ph = $("#acct-photo");
    const want = acct.photo || "";
    if (ph.dataset.src !== want) {
      ph.dataset.src = want;
      ph.innerHTML = want ? '<img src="' + esc(want) + '" onerror="this.remove()" alt="">' : "";
    }
    $("#acct-sync").disabled = syncBusy;
  }

  function syncAccount() {
    if (syncBusy) return;
    if (!S.online) { toast("internet yok", true); return; }
    syncBusy = true;
    renderAccount();
    spinner($("#acct-spin"), true);
    call("syncAccount").then((d) => {
      toast("↻ " + d.lists + " liste · " + d.songs + " şarkı eşitlendi");
      libMode = "lists";
      if (tab === "lib") renderLib();
    }).catch((e) => toast("eşitlenemedi: " + e.message, true)).finally(() => {
      syncBusy = false;
      spinner($("#acct-spin"), false);
      acct = J(FM.account(), acct);
      renderAccount();
    });
  }

  $("#acct-login").addEventListener("click", () => {
    if (!S.online) { toast("internet yok", true); return; }
    FM.login();
  });
  $("#acct-logout").addEventListener("click", () => confirmDo("YouTube hesabından çıkılsın mı? Eşitlenmiş listeler ve indirilenler telefonda kalır.", () => {
    FM.logout();
    acct = J(FM.account(), { loggedIn: false });
    renderAccount();
    toast("çıkış yapıldı");
  }));
  $("#acct-sync").addEventListener("click", syncAccount);
  $("#me").addEventListener("click", () => {
    if (acct.loggedIn) {
      menu({
        title: acct.name || "YouTube hesabı",
        sub: acct.handle || "",
        song: acct.photo ? { thumb: acct.photo } : null, remote: true,
        items: [
          { g: "↻", t: "Kitaplığı eşitle", fn: syncAccount },
          { g: "⌂", t: "Ana sayfayı yenile", fn: () => loadHome(true) },
          { g: "⚙", t: "Ayarlar", fn: openSettings },
          { g: "⏻", t: "Çıkış yap", danger: true, fn: () => $("#acct-logout").click() },
        ],
      });
    } else {
      menu({
        title: "Giriş yapılmadı",
        sub: "",
        items: [
          { g: "◉", t: "YouTube ile giriş yap", fn: () => $("#acct-login").click() },
          { g: "⚙", t: "Ayarlar", fn: openSettings },
        ],
      });
    }
  });

  // --- AYAR ------------------------------------------------------------------------------------------

  function renderPrefs() {
    $$("[data-pref]").forEach((seg) => {
      const v = prefs[seg.dataset.pref];
      $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === v)));
    });
    $$("[data-pref-switch]").forEach((sw) => sw.setAttribute("aria-checked", String(prefs[sw.dataset.prefSwitch] === "true")));
  }
  $$("[data-pref]").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    prefs[seg.dataset.pref] = b.dataset.v;
    FM.setPref(seg.dataset.pref, b.dataset.v);
    renderPrefs();
  }));
  $$("[data-pref-switch]").forEach((sw) => sw.addEventListener("click", () => {
    const k = sw.dataset.prefSwitch;
    prefs[k] = prefs[k] === "true" ? "false" : "true";
    FM.setPref(k, prefs[k]);
    renderPrefs();
    if (k === "radio") { qs.for = null; qsTick(); }
  }));

  function renderStats() {
    const st = J(FM.stats(), {});
    $("#st-bytes").textContent = bytes(st.bytes || 0) + " · " + (st.downloaded || 0) + " şarkı";
    $("#sm-dl").textContent = (st.downloaded || 0) + " şarkı indirili · " + bytes(st.bytes || 0);
    $("#st-local").textContent = (st.local || 0) + " şarkı";
  }

  const DL_STATE = { wait: "bekliyor", run: "", done: "✓ indi", error: "hata" };
  function renderDownloads() {
    const d = J(FM.downloads(), []);
    const active = d.filter((x) => x.state === "wait" || x.state === "run").length;
    $("#dl-count").textContent = active ? active + " aktif" : String(d.length);
    $("#dl-list").innerHTML = d.length ? d.slice(0, 60).map((x) =>
      '<div class="dl-row ' + x.state + '"><span class="nm">' + esc(x.title) + "</span>" +
      (x.state === "run" ? '<span class="pb"><i style="width:' + Math.round(x.progress * 100) + '%"></i></span><span class="st">%' + Math.round(x.progress * 100) + "</span>" :
        '<span class="st">' + (x.state === "error" ? esc(x.error || "hata") : DL_STATE[x.state]) + "</span>") +
      "</div>").join("") : '<p class="muted mono" style="font-size:.78rem;margin:.2rem 0 0">indirme yok</p>';
  }
  $("#dl-clear").addEventListener("click", () => { FM.dlClear(); renderDownloads(); });
  $("#dl-cancel").addEventListener("click", () => { FM.dlCancel(); renderDownloads(); toast("indirmeler durduruldu"); });

  $("#scan").addEventListener("click", () => {
    const b = $("#scan");
    b.disabled = true;
    b.textContent = "TARANIYOR…";
    call("scanLocal").then((d) => {
      toast("◆ " + d.count + " yerel şarkı bulundu");
      renderStats();
    }).catch((e) => toast(e.message, true)).finally(() => {
      b.disabled = false;
      b.textContent = "TELEFONU TARA";
    });
  });

  function renderUpdate() {
    const u = S.update;
    if (!u) return;
    const btn = $("#upd-install");
    const cur = "kurulu: <b>v" + esc(u.current) + "</b>";
    btn.hidden = !(u.phase === "available" || (u.phase === "error" && u.latest));
    btn.textContent = "İNDİR VE KUR " + (u.latest || "");
    $("#upd-bar").hidden = !(u.phase === "downloading" || u.phase === "installing");
    $("#upd-fill").style.width = Math.round((u.progress || 0) * 100) + "%";
    $("#upd-badge").hidden = u.phase !== "available";
    $("#sm-upd").innerHTML = "kurulu v" + esc(u.current) + (u.phase === "available" ? ' · yeni: <b class="red">' + esc(u.latest) + "</b>" : "");
    $("#upd-check").disabled = u.phase === "checking" || u.phase === "downloading";
    const notes = $("#upd-notes");
    notes.hidden = !(u.phase === "available" && u.notes);
    notes.textContent = u.notes || "";
    $("#upd-info").innerHTML = {
      idle: cur,
      checking: cur + " · kontrol ediliyor…",
      latest: cur + " · <b>güncel</b>" + (u.latest ? " (son: " + esc(u.latest) + ")" : ""),
      available: cur + " · yeni sürüm <b class=\"red\">" + esc(u.latest) + "</b>",
      downloading: cur + " · indiriliyor %" + Math.round((u.progress || 0) * 100),
      installing: cur + " · kurulum penceresi açılıyor…",
      error: cur + " · <span class=\"red\">" + esc(u.error || "hata") + "</span>",
    }[u.phase] || cur;
    // Sekmede küçük kırmızı nokta: yeni sürüm var.
    const t = $("#gear");
    let dot = t.querySelector(".upd");
    if (u.phase === "available" && !dot) { dot = document.createElement("span"); dot.className = "upd"; t.appendChild(dot); }
    if (u.phase !== "available" && dot) dot.remove();
  }
  $("#upd-check").addEventListener("click", () => {
    if (!S.online) { toast("internet yok", true); return; }
    FM.checkUpdate(); setTimeout(poll, 150);
  });
  $("#upd-install").addEventListener("click", () => { FM.installUpdate(); setTimeout(poll, 150); });

  // --- animasyon ayarları ------------------------------------------------------------------------

  function renderAnim() {
    $("#anim-list").innerHTML = ANIMS.map((x) => {
      const c = anim[x.k];
      return '<div class="an-row' + (c.on ? "" : " is-off") + '" data-an="' + x.k + '">' +
        '<div class="head"><div class="n">' + x.n + '</div><span class="val">' + (c.on ? Number(c.speed).toFixed(2).replace(/0$/, "") + "×" : "kapalı") + "</span>" +
        '<button class="switch" type="button" role="switch" aria-checked="' + c.on + '"></button></div>' +
        '<div class="d">' + x.d + " · " + (c.on ? ams(x.k) + " ms" : "anında") + "</div>" +
        '<input type="range" min="0.25" max="3" step="0.25" value="' + c.speed + '" aria-label="hız" />' +
        '<div class="row-btns demo"><button class="btn btn-ghost" type="button" data-demo>DENE ▶</button></div></div>';
    }).join("");
  }
  $("#anim-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-an]");
    if (!row) return;
    const k = row.dataset.an;
    if (e.target.closest(".switch")) { anim[k].on = !anim[k].on; applyAnim(); renderAnim(); return; }
    if (e.target.closest("[data-demo]")) {
      if (k === "menu") menu({ title: "ÖRNEK MENÜ", sub: "hız: " + anim.menu.speed + "×", items: [{ g: "✓", t: "Tamam", fn: () => {} }] });
      else if (k === "modal") confirmDo("Bu bir örnek pencere.", () => {});
      else if (k === "toast") toast("örnek bildirim");
      else if (k === "over") { showSetMenu(true); setTimeout(() => openSub("anim"), Math.max(80, ams("over"))); }
      else if (k === "tab") { closeSettings(); go(tab === "home" ? "lib" : "home"); }
    }
  });
  $("#anim-list").addEventListener("input", (e) => {
    const row = e.target.closest("[data-an]");
    if (!row || e.target.type !== "range") return;
    anim[row.dataset.an].speed = Number(e.target.value);
    applyAnim();
    const c = anim[row.dataset.an];
    $(".val", row).textContent = c.on ? c.speed.toFixed(2).replace(/0$/, "") + "×" : "kapalı";
    $(".d", row).textContent = ANIMS.find((x) => x.k === row.dataset.an).d + " · " + (c.on ? ams(row.dataset.an) + " ms" : "anında");
  });
  $("#anim-reset").addEventListener("click", () => { anim = animDefaults(); applyAnim(); renderAnim(); toast("animasyonlar varsayılana döndü"); });

  // --- olaylar ---------------------------------------------------------------------------------------

  let lastLog = 0;
  function pollLogs() {
    const lines = J(FM.logs(lastLog), []);
    const term = $("#term");
    if (!lines.length) {
      if (!term.children.length) term.innerHTML = '<div class="empty">olay yok</div>';
      return;
    }
    const empty = $(".empty", term);
    if (empty) empty.remove();
    for (const l of lines) {
      lastLog = l.id;
      const d = new Date(l.t);
      const div = document.createElement("div");
      div.className = "ln";
      div.innerHTML = '<span class="t">' + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + '</span> <span class="g ' + esc(l.tag) + '">' + esc(l.tag) + "</span> " + esc(l.msg);
      term.prepend(div);
    }
    while (term.children.length > 40) term.lastChild.remove();
  }
  $("#log-clear").addEventListener("click", () => { FM.clearLogs(); $("#term").innerHTML = ""; lastLog = 0; pollLogs(); });

  // --- bağlantı göstergesi ----------------------------------------------------------------------------

  let wasOnline = null;
  function renderConn() {
    const c = $("#conn");
    c.hidden = !!S.online && !S.dlActive;
    c.className = "conn " + (S.online ? "is-ok" : "is-off");
    $("span", c).textContent = S.online ? "↓" + S.dlActive : (S.dlActive ? "↓" + S.dlActive + " · " : "") + "ÇEVRİMDIŞI";
    if (wasOnline !== null && wasOnline !== S.online) {
      toast(S.online ? "internet geldi" : "çevrimdışı — indirilenler çalmaya devam eder");
      renderQueue();
      if (tab === "lib") renderLib();
      renderSearchState();
      if (S.online) loadHome(false);
      if (tab === "home") renderHome();
    }
    wasOnline = S.online;
  }

  // --- öneriler ----------------------------------------------------------------------------------

  /** Birkaç tohum şarkının "benzer şarkılar"ını karıştırıp birleştir; zaten olanları çıkar. */
  function suggest(seeds, exclude, max) {
    const ids = seeds.filter((s) => s && String(s.id || "").startsWith("yt:")).slice(0, 3);
    if (!ids.length) return Promise.resolve([]);
    return Promise.all(ids.map((s) => call("similar", s.id.slice(3)).then((d) => d.songs || []).catch(() => [])))
      .then((lists) => {
        const out = [], seen = new Set(exclude);
        for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
          for (const l of lists) {
            const x = l[i];
            if (x && !seen.has(x.id)) { seen.add(x.id); out.push(Object.assign({ kind: "song" }, x)); }
          }
        }
        return out.slice(0, max);
      });
  }

  // Sıranın altında: çalan şarkıya (ve sıradakilere) göre öneriler. ＋ → sıranın sonuna.
  let qs = { for: null, items: [], busy: false };
  function qsTick() {
    const on = prefs.radio === "true";
    $("#qs-panel").hidden = !on;
    if (!on || !S.online || !S.cur || qs.busy) return;
    if (qs.for === S.cur.id) return;
    loadQs();
  }
  function loadQs() {
    if (!S.cur) return;
    qs.busy = true;
    qs.for = S.cur.id;
    spinner($("#qs-spin"), !qs.items.length);
    const seeds = [S.cur].concat(queue.slice(S.index + 1, S.index + 3));
    suggest(seeds, queue.map((q) => q.id), 20).then((items) => {
      qs.items = items;
      renderQs();
    }).finally(() => { qs.busy = false; spinner($("#qs-spin"), false); });
  }
  function renderQs() {
    const have = new Set(queue.map((q) => q.id));
    qs.items = qs.items.filter((x) => !have.has(x.id));
    $("#qs-list").innerHTML = qs.items.length ? qs.items.map((s, k) => songRow(s, k, { remote: !s.dl })).join("")
      : '<div class="empty-box">öneri yok</div>';
  }
  bindSongList($("#qs-list"), () => qs.items, () => ({
    kind: "qsugg",
    onAdd: (it) => {
      enqueue([it], "end");
      qs.items = qs.items.filter((x) => x.id !== it.id);
      renderQs();
    },
  }));
  $("#qs-refresh").addEventListener("click", () => { if (!S.online) { toast("internet yok", true); return; } qs.items = []; loadQs(); });

  // --- döngü ------------------------------------------------------------------------------------------

  let ticks = 0;

  function poll() {
    const s = J(FM.state(), null);
    if (!s) return;
    S = s;
    const libChanged = s.lrev !== lrev;
    if (libChanged) {
      lrev = s.lrev;
      lib = J(FM.library(), []);
    }
    if (s.qrev !== qrev || libChanged) {
      qrev = s.qrev;
      queue = J(FM.queue(), []);
      renderQueue();
      if (prefs.radio === "true" && qs.items.length) renderQs();
    } else {
      markQueue();
    }
    if (s.arev !== arev) {
      const was = acct.loggedIn;
      arev = s.arev;
      acct = J(FM.account(), acct);
      renderAccount();
      if (tab === "lib") renderLib();
      if (!was && acct.loggedIn) { toast("◉ giriş yapıldı — kitaplık eşitleniyor"); syncAccount(); loadHome(true); }
    } else if (settingsOpen && acct.loggedIn) {
      renderAccount();
    }
    renderConn();
    renderNow();
    renderMini();
    renderUpdate();
    if (libChanged) {
      if (tab === "home") renderHome();
      if (tab === "lib") renderLib();
      if (sh) reloadSheet();
      if (tab === "search" && sResults.length) renderSearch();
      if (settingsOpen) renderStats();
    }
    if (settingsOpen) {
      if (s.drev !== drev || s.dlActive) { drev = s.drev; renderDownloads(); }
      if (ticks % 4 === 0) pollLogs();
    }
    if (ticks % 20 === 0) loadHome(false);
    qsTick();
    ticks++;
  }

  renderPrefs();
  renderAccount();
  try { poll(); } catch (e) { showErr(e.message + " (ilk yükleme)"); }
  setInterval(() => { try { poll(); } catch (e) { showErr(e.message); } }, 500);
  renderHome();
  try { if (FM.boot) FM.boot("ready"); } catch (e) { /* yok */ }

  // --- tarayıcıda geliştirme için sahte köprü ----------------------------------------------------------

  function mockBridge() {
    const songs = [];
    const titles = [
      ["Gesi Bağları", "Barış Manço"], ["Arkadaşım Eşek", "Barış Manço"], ["Kara Sevda", "Cem Karaca"],
      ["Islak Islak", "Cem Karaca"], ["Sarı Laleler", "Erkin Koray"], ["Cemalim", "Erkin Koray"],
      ["Gönül Sabreyle", "Selda Bağcan"], ["Yaz Gülü", "Kâzım Koyuncu"], ["Hadi Bakalım", "Sezen Aksu"],
      ["Rüzgar", "Mor ve Ötesi"], ["Bir Derdim Var", "mor ve ötesi"], ["Unuttun mu Beni", "Duman"],
    ];
    titles.forEach(([t, a], i) => songs.push({ id: "yt:mock" + i, title: t, artist: a, dur: 180 + i * 13, thumb: "", dl: i % 3 !== 2, local: false, liked: i === 1, addedAt: Date.now() - i * 1e6 }));
    const q = songs.slice(0, 7).map((s) => s.id);
    const st = { index: 2, pos: 61000, playing: true, repeat: 0 };
    let qr = 1, lr = 1;
    const lists = [{ id: "p1", name: "yol şarkıları", songs: ["yt:mock0", "yt:mock3", "yt:mock5"] }];
    const find = (id) => songs.find((s) => s.id === id);
    setInterval(() => { if (st.playing) st.pos += 500; }, 500);
    return {
      version: () => "0.1.dev",
      state: () => JSON.stringify({
        ready: true, playing: st.playing, want: st.playing, state: 3, index: st.index, count: q.length,
        pos: st.pos, dur: (find(q[st.index]) || {}).dur * 1000 || 0, repeat: st.repeat, cur: find(q[st.index]) || null,
        qrev: qr, lrev: lr, drev: 1, dlActive: 1, online: true,
        update: { phase: "latest", current: "0.1.dev", latest: "v0.1.dev", notes: "", progress: 0, error: null },
      }),
      queue: () => JSON.stringify(q.map(find)),
      play: () => { st.playing = true; }, pause: () => { st.playing = false; }, toggle: () => { st.playing = !st.playing; },
      next: () => { st.index = Math.min(q.length - 1, st.index + 1); st.pos = 0; },
      prev: () => { st.index = Math.max(0, st.index - 1); st.pos = 0; },
      seek: (ms) => { st.pos = ms; }, jump: (i) => { st.index = i; st.pos = 0; },
      repeat: () => { st.repeat = { 0: 2, 2: 1, 1: 0 }[st.repeat]; },
      enqueue: (json, mode) => { const a = JSON.parse(json).map((s) => s.id); if (mode === "end") q.push(...a); else q.splice(st.index + 1, 0, ...a); qr++; return a.length; },
      move: (f, t) => { q.splice(t, 0, q.splice(f, 1)[0]); qr++; },
      remove: (i) => { q.splice(i, 1); qr++; }, clearUpcoming: () => { q.length = st.index + 1; qr++; }, clearQueue: () => { q.length = 0; qr++; },
      shuffleUpcoming: () => { qr++; }, saveQueue: () => "p2",
      library: () => JSON.stringify(songs), remember: () => 1, like: () => { lr++; }, deleteDownload: () => {}, forget: () => {},
      stats: () => JSON.stringify({ songs: songs.length, downloaded: 8, local: 0, bytes: 52e6 }),
      playlists: () => JSON.stringify(lists.map((p) => ({ id: p.id, name: p.name, count: p.songs.length, dl: 2, cover: p.songs[0], yt: p.id === "p1", ids: p.songs, coverV: "0-0", custom: false, src: null }))),
      playlist: (id) => { const p = lists.find((x) => x.id === id); return p ? JSON.stringify({ id: p.id, name: p.name, songs: p.songs.map(find) }) : "null"; },
      createPlaylist: () => "p3", addToPlaylist: () => 1, plRemove: () => {}, plMove: () => {}, plRename: () => {}, plDelete: () => {},
      download: () => 1,
      downloads: () => JSON.stringify([{ id: "yt:mock2", title: "Kara Sevda", state: "run", progress: 0.42, error: null }, { id: "yt:mock5", title: "Cemalim", state: "done", progress: 1, error: null }]),
      dlCancel: () => {}, dlClear: () => {},
      search: (req, q, f) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: f === "artists"
        ? [{ kind: "artist", artist: "UC1", title: "TV Girl", subs: 1240000, thumb: "" }]
        : songs.slice(3, 9).map((s) => Object.assign({ kind: "song" }, s)) })), 600),
      importLink: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { name: "örnek liste", songs: songs.slice(0, 5) } })), 600),
      openList: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { name: "albüm", songs: songs.slice(2, 8) } })), 600),
      scanLocal: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { count: 0 } })), 300),
      prefs: () => JSON.stringify({ quality: "high", autoDl: "wifi", tap: "now", skipOffline: "true", dlWifiOnly: "false" }),
      home: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: [
        { title: "Hızlı seçim", strap: "", rows: false, items: songs.slice(0, 9).map((x) => Object.assign({ kind: "song" }, x)) },
        { title: "Unutulan favoriler", strap: "", rows: false, items: songs.slice(3, 9).map((x) => Object.assign({ kind: "song" }, x)) },
        { title: "Karışıklar", strap: "senin için", rows: false, items: [{ kind: "list", list: "RDTMAK", title: "Mix 1", artist: "Barış Manço, Cem Karaca", thumb: "" }] },
      ] })), 500),
      openYt: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { name: "Mix 1", songs: songs.slice(1, 6) } })), 500),
      jsError: () => {},
      similar: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { name: "mix", songs: songs.slice(8, 12) } })), 300),
      boot: () => {}, touch: () => {}, pickCover: () => {}, removeCover: () => {},
      artist: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { name: "TV Girl", thumb: "", all: "OLAK1", songs: songs.slice(0, 5), lists: [{ kind: "list", list: "OLAK2", title: "French Exit", artist: "Albüm · 2014", thumb: "" }] } })), 400),
      account: () => JSON.stringify({ loggedIn: true, name: "Flux", handle: "@fluxthedew", photo: "", syncedAt: Date.now() - 36e5 }),
      login: () => {}, logout: () => {},
      syncAccount: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { lists: 4, songs: 212 } })), 1500),
      syncList: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { songs: 40 } })), 600),
      setPref: () => {}, checkUpdate: () => {}, installUpdate: () => {},
      logs: () => "[]", clearLogs: () => {},
    };
  }
})();
