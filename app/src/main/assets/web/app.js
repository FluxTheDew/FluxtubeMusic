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
  $$(".bnav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
  document.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g) { closePlayer(); closeSettings(); go(g.dataset.go); }
  });

  // --- tam ekran: çalar ve ayarlar -------------------------------------------------------

  function openPlayer() {
    playerOpen = true;
    $("#player").hidden = false;
    renderMini();
    const cur = $("#queue .row.is-cur");
    if (cur) setTimeout(() => cur.scrollIntoView({ block: "center" }), 30);
  }
  function closePlayer() {
    if (!playerOpen) return;
    playerOpen = false;
    $("#player").hidden = true;
    renderMini();
  }
  function openSettings() {
    settingsOpen = true;
    $("#settings").hidden = false;
    renderPrefs(); renderDownloads(); renderStats(); renderAccount(); pollLogs();
  }
  function closeSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    $("#settings").hidden = true;
  }
  $("#player-close").addEventListener("click", closePlayer);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#gear").addEventListener("click", openSettings);
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
    if ($(".modal")) { $(".modal").remove(); return true; }
    if ($(".scrim")) { closeMenu(); return true; }
    if (!$("#sheet").hidden) { closeSheet(); return true; }
    if (playerOpen) { closePlayer(); return true; }
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
  function tapSong(song) {
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
        if (it && it.kind !== "list") openSongMenu(it, Object.assign({ k: Number(row.dataset[attr]), items: getItems() }, getCtx ? getCtx() : {}));
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
    el.addEventListener("click", (e) => {
      if (lpFired) { lpFired = false; return; }
      const row = e.target.closest(sel);
      if (!row || e.target.closest(".handle")) return;
      const k = Number(row.dataset[attr]);
      const items = getItems();
      const it = items[k];
      if (!it) return;
      const ctx = Object.assign({ k, items }, getCtx ? getCtx() : {});
      if (it.kind === "list") { openYtList(it.list || it.url, it.title); return; }
      if (it.kind === "pl") { openPlaylist(it.id); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "add") enqueue([it], "end");
      else if (act === "more") openSongMenu(it, ctx);
      else tapSong(it);
    });
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
      const scroller = listEl.closest(".page, .sheet-list") || document.scrollingElement;
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
      el.innerHTML = '<div class="empty-box">sıra boş — KİTAPLIK ya da ARA\'dan ekle</div>';
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

  $("#queue").addEventListener("click", (e) => {
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
    m.hidden = playerOpen || !c;
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
    if (it.kind === "pl") src = it.cover ? "https://fm.art/" + encodeURIComponent(it.cover) : "";
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
      items: pls.map((p) => ({ kind: "pl", id: p.id, title: p.name, artist: p.count + " şarkı" + (p.yt ? " · YT" : ""), cover: p.cover })),
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
    } else if (c === "dl" || c === "liked") {
      libMode = c; libLimit = LIB_LIMIT; go("lib");
    } else if (c === "local") {
      const loc = lib.filter((x) => x.local);
      if (loc.length) enqueue(loc, "shuffle"); else toast("yerel şarkı yok — ⚙ → TELEFONU TARA");
    } else if (c === "refresh") {
      if (!S.online) { toast("internet yok", true); return; }
      loadHome(true);
      renderHome();
    }
  });

  // --- KİTAPLIK ------------------------------------------------------------------------------------

  let libMode = "dl";
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

  function renderLib() {
    $$("#lib-mode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === libMode)));
    const isLists = libMode === "lists";
    $("#lib-bar").hidden = isLists;
    $("#lists-bar").hidden = !isLists;
    $("#pl-sync").hidden = !acct.loggedIn;
    $("#lib-q").placeholder = isLists ? "listelerde ara" : "kitaplıkta ara (internetsiz çalışır)";
    $("#lib-q-x").hidden = !$("#lib-q").value;
    const el = $("#lib-list");

    if (isLists) {
      lists = J(FM.playlists(), []);
      const q = norm($("#lib-q").value.trim());
      const shown = q ? lists.filter((p) => norm(p.name).includes(q)) : lists;
      $("#lib-sec").innerHTML = "<b>≡</b> " + lists.length + " liste";
      if (!shown.length) {
        el.innerHTML = '<div class="empty-box">' + (lists.length ? "eşleşen liste yok" : "henüz liste yok — ＋ YENİ LİSTE ya da bir YouTube listesini linkten al") + "</div>";
        return;
      }
      el.innerHTML = shown.map((p) =>
        '<div class="row pl-row" data-pl="' + esc(p.id) + '">' +
        (p.cover ? artHtml({ id: p.cover }, false) : '<div class="art"></div>') +
        '<div class="t"><div class="nm">' + esc(p.name) + '</div><div class="ar">' + (p.yt ? '<span class="yt-tag">YT</span> · ' : "") + p.count + " şarkı · " +
        (p.dl === p.count && p.count ? '<span class="dl">↓ hepsi indirili</span>' : p.dl + " indirili") + "</div></div>" +
        '<button class="more" type="button" data-act="plmore">⋯</button></div>').join("");
      return;
    }

    libShown = libFiltered();
    const dl = lib.filter((s) => s.dl).length;
    $("#lib-sec").innerHTML = "<b>♪</b> " + libShown.length + " şarkı" + (libMode === "all" ? " · " + dl + " internetsiz çalar" : "");
    if (!libShown.length) {
      const msg = $("#lib-q").value ? "eşleşen şarkı yok" : {
        dl: "henüz indirilen yok — bir şarkıda ⋯ → İNDİR, ya da AYAR → otomatik indir",
        all: "kitaplık boş — ARA'dan şarkı bul ya da AYAR → TELEFONU TARA",
        liked: "beğenilen yok — ⋯ → BEĞEN",
      }[libMode];
      el.innerHTML = '<div class="empty-box">' + msg + "</div>";
      return;
    }
    const part = libShown.slice(0, libLimit);
    el.innerHTML = part.map((s, k) => songRow(s, k)).join("") +
      (libShown.length > part.length ? '<button class="btn btn-ghost" style="margin:1rem auto" type="button" id="lib-more">+ ' + (libShown.length - part.length) + " DAHA</button>" : "");
  }

  $$("#lib-mode button").forEach((b) => b.addEventListener("click", () => { libMode = b.dataset.mode; libLimit = LIB_LIMIT; renderLib(); }));
  $("#lib-q").addEventListener("input", () => { libLimit = LIB_LIMIT; renderLib(); });
  $("#lib-q-x").addEventListener("click", (e) => { e.preventDefault(); $("#lib-q").value = ""; renderLib(); });
  bindSongList($("#lib-list"), () => libShown, () => ({ kind: "lib" }));
  $("#lib-list").addEventListener("click", (e) => {
    if (e.target.closest("#lib-more")) { libLimit += LIB_LIMIT; renderLib(); return; }
    const pl = e.target.closest("[data-pl]");
    if (!pl) return;
    if (e.target.closest("[data-act=plmore]")) { openListMenu(pl.dataset.pl); return; }
    openPlaylist(pl.dataset.pl);
  });
  $("#lib-play").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "replace"); else toast("liste boş"); });
  $("#lib-shuf").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "shuffle"); else toast("liste boş"); });
  $("#lib-add").addEventListener("click", () => { if (libShown.length) enqueue(libShown, "end"); else toast("liste boş"); });
  $("#pl-new").addEventListener("click", () => ask("YENİ LİSTE", "", (name) => { FM.createPlaylist(name, "[]"); toast("≡ oluşturuldu: " + name); renderLib(); }));
  $("#pl-link").addEventListener("click", () => {
    ask("YOUTUBE / YT MUSIC LİNKİ", "", (url) => importLink(url), { placeholder: "https://music.youtube.com/playlist?list=…", ok: "AL" });
  });

  // --- liste ayrıntısı (sheet) ---------------------------------------------------------------------

  /** sh = { kind: "pl" | "yt", id?, url?, name, songs } */
  let sh = null;

  function openSheet(data) {
    sh = data;
    $("#sheet").hidden = false;
    renderSheet();
  }
  function closeSheet() {
    $("#sheet").hidden = true;
    sh = null;
    spinner($("#sheet-spin"), false);
  }
  function renderSheet() {
    if (!sh) return;
    $("#sheet-title").textContent = sh.name || "LİSTE";
    const songs = sh.songs || [];
    const dl = songs.filter((s) => s.dl).length;
    $("#sheet-sec").innerHTML = sh.loading ? "" : "<b>♪</b> " + songs.length + " şarkı · " + dl + " indirili" + (sh.kind === "yt" ? " · YouTube'dan" : "");
    $("#sheet-bar").hidden = !!sh.loading;
    const el = $("#sheet-list");
    if (sh.loading) { el.innerHTML = ""; return; }
    if (!songs.length) {
      el.innerHTML = '<div class="empty-box">' + (sh.kind === "pl" ? "liste boş — şarkılarda ⋯ → LİSTEYE EKLE" : "şarkı bulunamadı") + "</div>";
      return;
    }
    el.innerHTML = songs.map((s, k) => songRow(s, k, { handle: sh.kind === "pl", remote: sh.kind === "yt" && !s.dl })).join("");
  }
  function openPlaylist(id) {
    const p = J(FM.playlist(id), null);
    if (!p) { toast("liste bulunamadı", true); return; }
    openSheet({ kind: "pl", id: p.id, name: p.name, songs: p.songs });
  }
  function reloadSheet() {
    if (sh && sh.kind === "pl") {
      const p = J(FM.playlist(sh.id), null);
      if (!p) { closeSheet(); return; }
      sh.name = p.name; sh.songs = p.songs;
      renderSheet();
    } else if (sh && sh.kind === "yt" && sh.songs) {
      // İndirme durumu değişmiş olabilir.
      const byId = new Map(lib.map((s) => [s.id, s]));
      sh.songs = sh.songs.map((s) => byId.get(s.id) || s);
      renderSheet();
    }
  }
  /** YouTube listesi / albüm / karışık: kimlik (PL…, OLAK…, RD…) ya da adres. */
  function openYtList(ref, name) {
    if (!S.online) { toast("internet yok", true); return; }
    const m = /[?&]list=([\w-]+)/.exec(ref || "");
    const id = m ? m[1] : (/^[\w-]+$/.test(ref || "") ? ref : null);
    openSheet({ kind: "yt", url: ref, name: name || "LİSTE", loading: true, songs: [] });
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
  bindSongList($("#sheet-list"), () => (sh ? sh.songs : []), () => (sh ? { kind: sh.kind, pid: sh.id } : {}));
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
        { g: "≡", t: "Liste olarak kaydet", sub: "internetsiz de durur", fn: () => saveYtList() },
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
        p.yt && { g: "↻", t: "YouTube'dan tazele", sub: "hesaptaki son hali", fn: () => {
          if (!S.online) { toast("internet yok", true); return; }
          toast("↻ tazeleniyor…");
          call("syncList", pid).then((d) => { toast("↻ " + d.songs + " şarkı"); reloadSheet(); }).catch((e) => toast(e.message, true));
        } },
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
  function renderSearch() {
    const el = $("#s-list");
    $("#s-sec").innerHTML = sLastQ ? "<b>&gt;</b> “" + esc(sLastQ) + "” · " + sResults.length + " sonuç" : "";
    if (!sResults.length) { el.innerHTML = sLastQ ? '<div class="empty-box">sonuç yok</div>' : ""; return; }
    const byId = new Map(lib.map((s) => [s.id, s]));
    el.innerHTML = sResults.map((r, k) => {
      if (r.kind === "list") {
        return '<div class="row pl-row" data-k="' + k + '">' + artHtml(r, true) +
          '<div class="t"><div class="nm">' + esc(r.title) + '</div><div class="ar">' + esc(r.artist || "") + (r.count > 0 ? " · " + r.count + " şarkı" : "") + "</div></div>" +
          '<span class="more">→</span></div>';
      }
      const known = byId.get(r.id);
      return songRow(known ? Object.assign({}, r, { dl: known.dl, liked: known.liked }) : r, k, { remote: true });
    }).join("");
  }
  function doSearch() {
    const q = $("#s-q").value.trim();
    if (!q) return;
    $("#s-q").blur();
    if (/^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\//i.test(q)) { importLink(q); return; }
    if (!S.online) { renderSearchState(); toast("internet yok", true); return; }
    sLastQ = q;
    const f = sFilter;
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
  $("#s-form").addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });
  $$("#s-filter button").forEach((b) => b.addEventListener("click", () => {
    sFilter = b.dataset.f;
    $$("#s-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if ($("#s-q").value.trim()) doSearch();
  }));
  bindSongList($("#s-list"), () => sResults, () => ({ kind: "search" }));

  // --- şarkı menüsü --------------------------------------------------------------------------------

  function closeMenu() { $$(".scrim").forEach((m) => m.remove()); }

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
      { g: "▶", t: "Şimdi çal", sub: "sıra korunur", fn: () => enqueue([song], "now") },
      { g: "↳", t: "Sıradaki", fn: () => enqueue([song], "next") },
      { g: "＋", t: "Sıranın sonuna ekle", fn: () => enqueue([song], "end") },
    ];
    if (ctx && ctx.items && ctx.items.length > 1 && ctx.kind !== "search") {
      items.push({ g: "⏵", t: "Buradan itibaren çal", sub: "sıra bu listeyle değişir", fn: () => enqueue(ctx.items, "replace", ctx.k) });
    }
    if (!song.local) {
      if (song.dl) items.push({ g: "✕", t: "İndirmeyi sil", sub: "kitaplıkta kalır", fn: () => { FM.deleteDownload(song.id); toast("indirme silindi"); } });
      else items.push({ g: "↓", t: "İndir", sub: "internetsiz çalsın", fn: () => { const n = FM.download(JSON.stringify([song])); toast(n ? "↓ indiriliyor" : "zaten indiriliyor"); } });
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
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-x]")) m.remove(); });
    $("form", m).addEventListener("submit", (e) => {
      e.preventDefault();
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      m.remove();
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
      if (e.target.closest("[data-ok]")) { m.remove(); fn(); setTimeout(poll, 120); return; }
      if (e.target === m || e.target.closest("[data-x]")) m.remove();
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
          { g: "↻", t: "Kitaplığı eşitle", sub: "YT listeleri + beğenilenler", fn: syncAccount },
          { g: "⌂", t: "Ana sayfayı yenile", fn: () => loadHome(true) },
          { g: "⚙", t: "Ayarlar", fn: openSettings },
          { g: "⏻", t: "Çıkış yap", danger: true, fn: () => $("#acct-logout").click() },
        ],
      });
    } else {
      menu({
        title: "Giriş yapılmadı",
        sub: "YouTube Music hesabını bağla: listelerin ve sana özel ana sayfa gelsin",
        items: [
          { g: "◉", t: "YouTube ile giriş yap", fn: () => $("#acct-login").click() },
          { g: "⚙", t: "Ayarlar", fn: openSettings },
        ],
      });
    }
  });
  $("#pl-sync").addEventListener("click", syncAccount);

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
  }));

  function renderStats() {
    const st = J(FM.stats(), {});
    $("#st-bytes").textContent = bytes(st.bytes || 0) + " · " + (st.downloaded || 0) + " şarkı";
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
      playlists: () => JSON.stringify(lists.map((p) => ({ id: p.id, name: p.name, count: p.songs.length, dl: 2, cover: p.songs[0], yt: p.id === "p1" }))),
      playlist: (id) => { const p = lists.find((x) => x.id === id); return p ? JSON.stringify({ id: p.id, name: p.name, songs: p.songs.map(find) }) : "null"; },
      createPlaylist: () => "p3", addToPlaylist: () => 1, plRemove: () => {}, plMove: () => {}, plRename: () => {}, plDelete: () => {},
      download: () => 1,
      downloads: () => JSON.stringify([{ id: "yt:mock2", title: "Kara Sevda", state: "run", progress: 0.42, error: null }, { id: "yt:mock5", title: "Cemalim", state: "done", progress: 1, error: null }]),
      dlCancel: () => {}, dlClear: () => {},
      search: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: songs.slice(3, 9).map((s) => Object.assign({ kind: "song" }, s)) })), 600),
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
      account: () => JSON.stringify({ loggedIn: true, name: "Flux", handle: "@fluxthedew", photo: "", syncedAt: Date.now() - 36e5 }),
      login: () => {}, logout: () => {},
      syncAccount: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { lists: 4, songs: 212 } })), 1500),
      syncList: (req) => setTimeout(() => window.FMcb(req, JSON.stringify({ ok: true, data: { songs: 40 } })), 600),
      setPref: () => {}, checkUpdate: () => {}, installUpdate: () => {},
      logs: () => "[]", clearLogs: () => {},
    };
  }
})();
