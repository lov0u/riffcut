/* ═══════════════════════════════════════════════════════════════════════
   剪辑台 —— 真能剪的那种。

   为什么自己写 DOM 预览而不是「渲一次再播」：
     剪映、达芬奇、Final Cut 的预览都是 DOM/Canvas 叠层，改一个参数立刻看到，
     不用等渲染。渲一次再播的话，改字号要等 10 秒，等于不能改。
     播放时 video 元素 currentTime 跟着播放头走，图片按时间显隐，
     文字直接叠成 div —— 出来就和成片一致（渲染层用的是同一套参数）。
   ═══════════════════════════════════════════════════════════════════════ */

const ED = {
  doc: null, assets: [], sel: null, playing: false, t: 0,
  pps: 60, raf: 0, dirty: false, timer: 0, undo: [], redo: [],
  drag: null,
};

const CSS = `
.ed{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg)}
.ed-top{flex:none;display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.ed-top .nm{font-size:var(--f2);font-weight:600;margin-right:4px}
.ed-top .sp{flex:1}
.ed-top .tm{color:var(--ink3);font-variant-numeric:tabular-nums;font-size:var(--f4);min-width:96px}
.ed-mid{flex:1;display:flex;min-height:0}
.ed-left{width:196px;flex:none;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.ed-left .hd{padding:8px 10px;color:var(--ink3);font-size:var(--f5);border-bottom:1px solid var(--line);letter-spacing:.04em}
.ed-pool{flex:1;overflow:auto;padding:8px}
.ed-pool .a{display:flex;align-items:center;gap:8px;padding:6px;border-radius:var(--r-sm);cursor:grab;margin-bottom:4px;border:1px solid transparent}
.ed-pool .a:hover{background:var(--hover);border-color:var(--line)}
.ed-pool .a img{width:40px;height:40px;object-fit:cover;border-radius:var(--r-sm);background:#000;flex:none}
.ed-pool .a .ic{width:40px;height:40px;border-radius:var(--r-sm);background:var(--raise);display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:16px;flex:none}
.ed-pool .a .tx{min-width:0;flex:1}
.ed-pool .a .tx b{display:block;font-weight:500;font-size:var(--f4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ed-pool .a .tx i{font-style:normal;color:var(--ink3);font-size:var(--f5)}
.ed-center{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:#0A0C0F}
.ed-stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:14px;position:relative}
.ed-frame{position:relative;background:#000;box-shadow:0 4px 30px rgba(0,0,0,.5);overflow:hidden}
.ed-frame video,.ed-frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:none}
.ed-frame .vl-tx{position:absolute;transform:translate(-50%,-50%);text-align:center;white-space:pre-wrap;line-height:1.35;text-shadow:0 2px 12px rgba(0,0,0,.5);max-width:86%;pointer-events:none;display:none}
.ed-right{width:232px;flex:none;border-left:1px solid var(--line);overflow:auto}
.ed-right .hd{padding:8px 12px;color:var(--ink3);font-size:var(--f5);border-bottom:1px solid var(--line);letter-spacing:.04em}
.ed-insp{padding:12px}
.ed-insp .f{margin-bottom:11px}
.ed-insp .f label{display:block;color:var(--ink3);font-size:var(--f5);margin-bottom:4px}
.ed-insp .f input,.ed-insp .f select,.ed-insp .f textarea{width:100%;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);color:var(--ink);outline:none;font-size:var(--f4)}
.ed-insp .f textarea{height:58px;padding:6px 8px;resize:vertical;line-height:1.4}
.ed-insp .f input[type=range]{height:20px;padding:0;background:transparent;border:0}
.ed-insp .f input[type=color]{height:28px;padding:2px}
.ed-insp .hint{color:var(--ink3);font-size:var(--f5);line-height:1.7;text-align:center;padding:30px 12px}
.ed-insp .row2{display:flex;gap:6px}
.ed-insp .row2>*{flex:1;min-width:0}
.ed-tl{flex:none;height:238px;border-top:1px solid var(--line);display:flex;flex-direction:column;background:var(--panel)}
.ed-tlhd{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--line);font-size:var(--f5);color:var(--ink3)}
.ed-tlhd .sp{flex:1}
.ed-tlbd{flex:1;display:flex;min-height:0}
.ed-lbs{width:56px;flex:none;border-right:1px solid var(--line);padding-top:22px}
.ed-lb{height:36px;display:flex;align-items:center;justify-content:center;color:var(--ink3);font-size:var(--f5);letter-spacing:.05em}
.ed-lb.on{color:var(--accent-ink)}
.ed-scroll{flex:1;overflow:auto;position:relative;min-width:0}
.ed-ruler{position:sticky;top:0;height:22px;background:var(--panel);border-bottom:1px solid var(--line);z-index:5;cursor:pointer}
.ed-ruler i{position:absolute;top:9px;width:1px;height:6px;background:#3A424E}
.ed-ruler b{position:absolute;top:3px;font-size:9px;color:var(--ink3);font-weight:400;transform:translateX(2px)}
.ed-lanes{position:relative;min-height:144px}
.ed-lane{height:36px;position:relative;border-bottom:1px solid rgba(255,255,255,.03)}
.ed-clip{position:absolute;top:4px;height:28px;border-radius:var(--r-sm);overflow:hidden;cursor:grab;
  display:flex;align-items:center;padding:0 7px;font-size:var(--f5);white-space:nowrap;
  border:1px solid;user-select:none;color:#DCE3EC}
.ed-clip.vid{background:rgba(43,110,160,.34);border-color:rgba(74,150,205,.55)}
.ed-clip.txt{background:rgba(27,139,126,.3);border-color:rgba(42,169,154,.6)}
.ed-clip.aud{background:rgba(160,120,50,.3);border-color:rgba(201,164,106,.55)}
.ed-clip.grp{background:rgba(120,90,170,.3);border-color:rgba(150,120,200,.55)}
.ed-clip.sel{outline:2px solid var(--accent-ink);outline-offset:-2px}
.ed-clip .hd{width:5px;position:absolute;right:0;top:0;bottom:0;cursor:ew-resize;background:rgba(255,255,255,.16)}
.ed-clip .hd:hover{background:var(--accent-ink)}
.ed-play{position:absolute;top:0;bottom:0;width:0;border-left:2px solid #E0533D;z-index:9;pointer-events:none}
.ed-play::before{content:'';position:absolute;top:0;left:-5px;border:5px solid transparent;border-top-color:#E0533D}
.ed-tip{color:var(--ink3);font-size:var(--f5);padding:22px;text-align:center;line-height:1.8}
.ed-ai{display:flex;gap:6px;margin-top:10px}
.ed-ai input{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--bg);color:var(--ink);font-size:var(--f4)}
`;

function edCss() {
  if (document.getElementById('ed-css')) return;
  const s = document.createElement('style');
  s.id = 'ed-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

const E = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const $$ = (q) => document.querySelector(q);

/* ── 时长的唯一算法 ────────────────────────────────────────────────
   文本/图片/模板只有 duration；视频/音频是 (out-in)/speed。
   全站只用这一个函数算，别处不许再写一遍 —— 两套算法必然对不上。 */
function clipLen(c) {
  if (!c) return 0;
  if (c.type === 'text' || c.type === 'image' || c.type === 'template') {
    return Math.max(0.1, Number(c.duration) || 3);
  }
  const raw = Math.max(0.1, (Number(c.out) || 0) - (Number(c.in) || 0));
  return raw / Math.max(0.1, Number(c.speed) || 1);
}
function clipEnd(c) { return (Number(c.start) || 0) + clipLen(c); }
function allClips(doc) {
  const out = [];
  for (const tr of doc.tracks || []) for (const c of tr.clips || []) out.push({ tr, c });
  return out;
}
function assetUrl(doc, src) {
  if (!src) return '';
  if (/^(https?|data|blob):/.test(src)) return src;
  return 'velora://proj/' + encodeURIComponent(doc.name) + '/' + String(src).replace(/^\.?\//, '');
}

/* ── 存盘（防抖 700ms）──────────────────────────────────────────── */
function edSave(now) {
  clearTimeout(ED.timer);
  const go = async () => {
    if (!ED.doc || !ED.dirty) return;
    ED.dirty = false;
    const r = await window.riffcut.tlSave(ED.doc.name, ED.doc);
    if (!r.ok) { console.error('[剪辑台] 存盘失败:', r.error); ED.dirty = true; }
  };
  if (now) return go();
  ED.timer = setTimeout(go, 700);
}

function edSnapshot() {
  if (!ED.doc) return;
  ED.undo.push(JSON.stringify(ED.doc));
  if (ED.undo.length > 40) ED.undo.shift();
  ED.redo.length = 0;
}
function edUndo() {
  if (!ED.undo.length) return;
  ED.redo.push(JSON.stringify(ED.doc));
  ED.doc = JSON.parse(ED.undo.pop());
  ED.dirty = true; edSave(); edRenderAll();
}
function edRedo() {
  if (!ED.redo.length) return;
  ED.undo.push(JSON.stringify(ED.doc));
  ED.doc = JSON.parse(ED.redo.pop());
  ED.dirty = true; edSave(); edRenderAll();
}

/* ── 播放 ───────────────────────────────────────────────────────── */
function edTogglePlay() {
  if (!ED.doc) return;
  ED.playing = !ED.playing;
  const b = $$('#edPlayBtn');
  if (b) b.textContent = ED.playing ? '暂停' : '播放';
  if (ED.playing) {
    if (ED.t >= edTotal() - 0.05) ED.t = 0;
    ED.t0 = performance.now() - ED.t * 1000;
    edTick();
  } else {
    cancelAnimationFrame(ED.raf);
    // 停的时候把视频也停住，否则音频还在跑
    document.querySelectorAll('.ed-frame video').forEach((v) => { try { v.pause() } catch {} });
  }
}
function edTotal() {
  if (!ED.doc) return 0;
  let end = 0;
  for (const { c } of allClips(ED.doc)) end = Math.max(end, clipEnd(c));
  return Math.max(Number(ED.doc.duration) || 0, end, 1);
}
function edTick() {
  if (!ED.playing) return;
  ED.t = (performance.now() - ED.t0) / 1000;
  if (ED.t >= edTotal()) { ED.t = edTotal(); edTogglePlay(); }
  edSeek(ED.t, true);
  ED.raf = requestAnimationFrame(edTick);
}

/* ── 跳转（核心：把 DOM 播放器和时间对齐）───────────────────────── */
function edSeek(t, follow) {
  ED.t = Math.max(0, Math.min(edTotal(), t));
  const ph = $$('#edPlay');
  if (ph) ph.style.left = (ED.t * ED.pps) + 'px';
  const tm = $$('#edTime');
  if (tm) tm.textContent = fmt(ED.t) + ' / ' + fmt(edTotal());
  if (follow) {
    const sc = $$('#edScroll');
    if (sc) {
      const x = ED.t * ED.pps, left = sc.scrollLeft, w = sc.clientWidth;
      if (x < left + 40 || x > left + w - 80) sc.scrollLeft = Math.max(0, x - w * 0.35);
    }
  }
  edPaintStage();
}
const fmt = (s) => {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
};

/* ── 预览画面：按当前时间决定每个元素显不显示、视频跳到第几秒 ─────── */
const _vidState = new Map();  // clipId → { el, loaded, want }
function edPaintStage() {
  const stage = $$('#edFrame');
  if (!stage || !ED.doc) return;
  const t = ED.t;

  // 视频/图片：同一时间点有几段就显几段（主视频轨叠加图形轨）
  for (const { tr, c } of allClips(ED.doc)) {
    if (c.type !== 'video' && c.type !== 'image') continue;
    const on = t >= Number(c.start) && t < clipEnd(c) + 0.001;
    const key = c.id;
    let st = _vidState.get(key);
    if (!st) {
      const el = c.type === 'image' ? document.createElement('img') : document.createElement('video');
      el.src = assetUrl(ED.doc, c.src);
      if (c.type === 'video') { el.preload = 'auto'; el.muted = false; el.playsInline = true; }
      el.style.objectFit = c.fit || 'cover';
      stage.appendChild(el);
      st = { el, type: c.type, last: -1 };
      _vidState.set(key, st);
    }
    st.el.style.display = on ? 'block' : 'none';
    st.el.style.opacity = String(c.opacity == null ? 1 : c.opacity);
    if (!on) { if (c.type === 'video') { try { st.el.pause() } catch {} } continue; }
    if (c.type === 'video') {
      // 片内第几秒 = (当前时间 - 片段起点) × 速度 + in
      const want = (t - Number(c.start)) * Math.max(0.1, Number(c.speed) || 1) + Number(c.in || 0);
      if (!ED.playing) {
        try { if (Math.abs(st.el.currentTime - want) > 0.04) st.el.currentTime = want } catch {}
        st.el.muted = true;  // 拖动时不放声音，否则一顿乱响
      } else {
        st.el.muted = Number(c.volume) === 0;
        st.el.volume = Math.max(0, Math.min(1, c.volume == null ? 1 : Number(c.volume)));
        st.el.playbackRate = Math.max(0.1, Number(c.speed) || 1);
        if (st.el.paused) st.el.play().catch(() => {});
        if (Math.abs(st.el.currentTime - want) > 0.25) { try { st.el.currentTime = want } catch {} }
      }
    }
  }
  // 清理已经被删掉的片段的 DOM
  const alive = new Set(allClips(ED.doc).map((x) => x.c.id));
  for (const [k, st] of _vidState) {
    if (!alive.has(k)) { st.el.remove(); _vidState.delete(k); }
  }

  // 文字层
  const tstage = $$('#edTxLayer');
  if (tstage) {
    tstage.innerHTML = '';
    for (const { c } of allClips(ED.doc)) {
      if (c.type !== 'text') continue;
      if (t < Number(c.start) || t >= clipEnd(c)) continue;
      const d = E('div', 'vl-tx', c.text || '');
      const w = ED.doc.width || 1080, h = ED.doc.height || 1920;
      d.style.cssText = `left:${(Number(c.x) || 0.5) * 100}%;top:${(Number(c.y) || 0.84) * 100}%;` +
        `font-size:${Math.round((Number(c.size) || 64) * ((stage.clientWidth || 360) / w))}px;` +
        `color:${c.color || '#fff'};opacity:${c.opacity == null ? 0.92 : c.opacity};` +
        `font-weight:${c.bold === false ? 400 : 600};display:block`;
      // 淡入淡出：和渲染层的 fadeIn/fadeOut 用同一组参数
      const fi = Number(c.fadeIn) || 0, fo = Number(c.fadeOut) || 0;
      const tIn = t - Number(c.start), tOut = clipEnd(c) - t;
      let a = 1;
      if (fi > 0 && tIn < fi) a = Math.min(a, tIn / fi);
      if (fo > 0 && tOut < fo) a = Math.min(a, tOut / fo);
      d.style.opacity = String((c.opacity == null ? 0.92 : c.opacity) * Math.max(0, a));
      tstage.appendChild(d);
    }
  }
}

/* ── 整屏重画 ───────────────────────────────────────────────────── */
function edRenderAll() {
  edPool(); edLanes(); edInsp(); edSeek(ED.t, false);
}

function edPool() {
  const box = $$('#edPool');
  if (!box || !ED.doc) return;
  box.innerHTML = '';
  const list = ED.assets || [];
  if (!list.length) {
    const e = E('div', 'ed-tip', '工程里还没有素材。\n把文件拖进这个窗口，\n或跟 AI 说一句要什么。');
    e.style.whiteSpace = 'pre-line';
    box.appendChild(e);
    return;
  }
  for (const a of list) {
    const row = E('div', 'a');
    row.draggable = true;
    if (a.kind === 'image') {
      const im = document.createElement('img');
      im.src = 'velora://proj/' + encodeURIComponent(ED.doc.name) + '/' + a.src;
      row.appendChild(im);
    } else {
      row.appendChild(E('div', 'ic', a.kind === 'video' ? '▶' : a.kind === 'audio' ? '♪' : '◇'));
    }
    const tx = E('div', 'tx');
    tx.appendChild(E('b', null, a.name));
    tx.appendChild(E('i', null, a.kind + '  ' + (a.size ? (a.size / 1048576).toFixed(1) + 'MB' : '')));
    row.appendChild(tx);
    row.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', 'asset:' + a.src);
      ev.dataTransfer.effectAllowed = 'copy';
    });
    // 双击 = 加到主视频轨末尾（不想拖的时候的最快路径）
    row.addEventListener('dblclick', () => edAddAtEnd(a));
    box.appendChild(row);
  }
}

function edAddAtEnd(a) {
  edSnapshot();
  const trId = a.kind === 'audio' ? 'a1' : 'v1';
  const tr = ED.doc.tracks.find((x) => x.id === trId) || ED.doc.tracks[0];
  const last = tr.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
  const dur = a.kind === 'image' ? 3 : 5;
  tr.clips.push(newClip(a, last, dur));
  ED.dirty = true; edSave(); edRenderAll();
  edSelect(trId, tr.clips[tr.clips.length - 1].id);
}

function newClip(a, start, dur) {
  const id = 'c' + Date.now() + '-' + Math.floor(Math.random() * 999);
  if (a.kind === 'image') {
    return { id, type: 'image', src: a.src, start: round3(start), duration: round3(dur), fit: 'cover', opacity: 1 };
  }
  if (a.kind === 'audio') {
    return { id, type: 'audio', src: a.src, start: round3(start), in: 0, out: round3(dur), speed: 1, volume: 1 };
  }
  return { id, type: 'video', src: a.src, start: round3(start), in: 0, out: round3(dur), speed: 1, volume: 1, fit: 'cover' };
}
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;

/* ── 时间线 ─────────────────────────────────────────────────────── */
function edLanes() {
  const rul = $$('#edRuler'), lanes = $$('#edLanes'), lbs = $$('#edLbs');
  if (!rul || !lanes || !ED.doc) return;
  const total = edTotal();
  const width = Math.max(600, (total + 4) * ED.pps);

  // 刻度：按缩放自动选步长，密到看不清就换大档
  rul.innerHTML = ''; rul.style.width = width + 'px';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
  let step = steps.find((s) => s * ED.pps >= 46) || 60;
  for (let s = 0; s <= total + 3; s += step) {
    const tick = document.createElement('i');
    tick.style.left = (s * ED.pps) + 'px';
    rul.appendChild(tick);
    const lb = document.createElement('b');
    lb.style.left = (s * ED.pps) + 'px';
    lb.textContent = s >= 60 ? Math.floor(s / 60) + 'm' : Math.round(s) + 's';
    rul.appendChild(lb);
  }

  lanes.innerHTML = ''; lanes.style.width = width + 'px';
  lbs.innerHTML = '';
  const KIND = { video: 'vid', text: 'txt', audio: 'aud', graphics: 'grp' };
  const LB = { v1: '主视频', g1: '图形', t1: '字幕', a1: '音频' };

  for (const tr of ED.doc.tracks) {
    const lb = E('div', 'ed-lb' + (ED.sel && ED.sel.trId === tr.id ? ' on' : ''), LB[tr.id] || tr.id);
    lbs.appendChild(lb);

    const lane = E('div', 'ed-lane');
    lane.dataset.tr = tr.id;
    for (const c of tr.clips) {
      const len = clipLen(c);
      const box = E('div', 'ed-clip ' + (KIND[tr.kind] || 'grp'));
      if (ED.sel && ED.sel.id === c.id) box.classList.add('sel');
      box.style.left = (Number(c.start) * ED.pps) + 'px';
      box.style.width = Math.max(14, len * ED.pps) + 'px';
      const label = c.text ? c.text : (c.src ? String(c.src).split('/').pop() : (c.type || ''));
      box.textContent = label;
      box.title = `${label}\n${Number(c.start).toFixed(2)}s → ${clipEnd(c).toFixed(2)}s`;
      const hd = E('div', 'hd');
      box.appendChild(hd);
      box.addEventListener('mousedown', (ev) => edClipDown(ev, tr, c, box));
      lane.appendChild(box);
    }
    // 点空白处 = 播放头跳到这里
    lane.addEventListener('mousedown', (ev) => {
      if (ev.target !== lane) return;
      const r = lane.getBoundingClientRect();
      edSeek((ev.clientX - r.left) / ED.pps, false);
    });
    lanes.appendChild(lane);
  }
  const ph = E('div', 'ed-play'); ph.id = 'edPlay';
  ph.style.left = (ED.t * ED.pps) + 'px';
  lanes.appendChild(ph);
}

/* 片段拖动：左半改起点，右边缘改时长 */
function edClipDown(ev, tr, c, box) {
  ev.preventDefault();
  ev.stopPropagation();
  edSelect(tr.id, c.id);
  const isHead = ev.target.classList.contains('hd');
  const r = box.getBoundingClientRect();
  ED.drag = {
    mode: isHead ? 'len' : 'move',
    tr, c,
    x0: ev.clientX, start0: Number(c.start) || 0, len0: clipLen(c),
    snap: !!ev.altKey, moved: false,
  };
  if (!isHead && ev.detail === 2) { /* 双击留给将来改名 */ }
  document.body.style.cursor = isHead ? 'ew-resize' : 'grabbing';
}

function edDragMove(ev) {
  const d = ED.drag;
  if (!d) return;
  const dx = ev.clientX - d.x0;
  if (Math.abs(dx) > 2) d.moved = true;
  if (!d.moved) return;
  // 吸附到 0.1 秒；按住 Alt 吸附到整秒（对齐节奏用）
  const unit = ev.altKey ? 1 : 0.1;
  const snapv = (v) => Math.round(v / unit) * unit;

  if (d.mode === 'move') {
    d.c.start = Math.max(0, round3(snapv(d.start0 + dx / ED.pps)));
  } else {
    const nl = Math.max(0.1, snapv(d.len0 + dx / ED.pps));
    if (d.c.type === 'text' || d.c.type === 'image' || d.c.type === 'template') {
      d.c.duration = round3(nl);
    } else {
      const sp = Math.max(0.1, Number(d.c.speed) || 1);
      d.c.out = round3(Number(d.c.in || 0) + nl * sp);
    }
  }
  ED.dirty = true;
  edLanes();
  edInsp();
  if (d.c) edSeek(Number(d.c.start), false);
}

function edDragUp() {
  const d = ED.drag;
  ED.drag = null;
  document.body.style.cursor = '';
  if (!d || !d.moved) return;
  edSnapshot();
  edSave();
  edRenderAll();
}

/* 素材拖到轨道 */
function edWireDrop(lanes) {
  lanes.addEventListener('dragover', (ev) => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; });
  lanes.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData('text/plain') || '';
    if (!raw.startsWith('asset:')) return;
    const src = raw.slice(6);
    const a = ED.assets.find((x) => x.src === src);
    if (!a) return;
    const laneEl = ev.target.closest('.ed-lane');
    const trId = laneEl ? laneEl.dataset.tr : 'v1';
    const tr = ED.doc.tracks.find((x) => x.id === trId);
    if (!tr) return;
    const r = laneEl.getBoundingClientRect();
    const start = Math.max(0, Math.round(((ev.clientX - r.left) / ED.pps) * 10) / 10);
    edSnapshot();
    const dur = a.kind === 'image' ? 3 : 5;
    tr.clips.push(newClip(a, start, dur));
    ED.dirty = true; edSave(); edRenderAll();
    edSelect(tr.id, tr.clips[tr.clips.length - 1].id);
  });
}

/* ── 选中与属性面板 ─────────────────────────────────────────────── */
function edSelect(trId, id) {
  ED.sel = (trId && id) ? { trId, id } : null;
  edLanes(); edInsp();
}

function edSelClip() {
  if (!ED.sel || !ED.doc) return null;
  const tr = ED.doc.tracks.find((x) => x.id === ED.sel.trId);
  if (!tr) return null;
  return tr.clips.find((c) => c.id === ED.sel.id) || null;
}

function edInsp() {
  const box = $$('#edInsp');
  if (!box) return;
  const c = edSelClip();
  if (!c) {
    box.innerHTML = '<div class="hint">在时间线上点一个片段，<br>这里就能改它的参数。<br><br>空格键播放<br>Delete 删片段<br>⌘Z 撤销</div>';
    return;
  }
  box.innerHTML = '';
  const mk = (label, node) => { const f = E('div', 'f'); f.appendChild(E('label', null, label)); f.appendChild(node); box.appendChild(f); return node; };

  // 起点 / 时长（通用）
  const r2 = E('div', 'row2');
  const inStart = E('input'); inStart.type = 'number'; inStart.step = '0.1'; inStart.min = '0'; inStart.value = Number(c.start).toFixed(1);
  const inLen = E('input'); inLen.type = 'number'; inLen.step = '0.1'; inLen.min = '0.1'; inLen.value = clipLen(c).toFixed(1);
  r2.appendChild(inStart); r2.appendChild(inLen);
  const f2 = E('div', 'f');
  const lb2 = E('label', null, '起点（秒）   时长（秒）');
  f2.appendChild(lb2); f2.appendChild(r2);
  box.appendChild(f2);
  const applyTime = () => {
    edSnapshot();
    c.start = Math.max(0, round3(inStart.value));
    const nl = Math.max(0.1, Number(inLen.value) || 0.1);
    if (c.type === 'text' || c.type === 'image' || c.type === 'template') c.duration = round3(nl);
    else c.out = round3(Number(c.in || 0) + nl * Math.max(0.1, Number(c.speed) || 1));
    ED.dirty = true; edSave(); edRenderAll();
  };
  inStart.onchange = applyTime; inLen.onchange = applyTime;

  if (c.type === 'text') {
    const ta = E('textarea'); ta.value = c.text || '';
    ta.oninput = () => { c.text = ta.value; ED.dirty = true; edSave(); edLanes(); edSeek(ED.t, false); };
    mk('文字', ta);

    const r3 = E('div', 'row2');
    const sz = E('input'); sz.type = 'number'; sz.value = c.size || 64; sz.min = '8'; sz.max = '400';
    const col = E('input'); col.type = 'color'; col.value = c.color || '#FFFFFF';
    r3.appendChild(sz); r3.appendChild(col);
    const f3 = E('div', 'f'); f3.appendChild(E('label', null, '字号（像素）  颜色')); f3.appendChild(r3); box.appendChild(f3);
    sz.onchange = () => { c.size = Math.max(8, Number(sz.value) || 64); ED.dirty = true; edSave(); edSeek(ED.t, false); };
    col.oninput = () => { c.color = col.value; ED.dirty = true; edSave(); edSeek(ED.t, false); };

    const xr = E('input'); xr.type = 'range'; xr.min = '0'; xr.max = '1'; xr.step = '0.01'; xr.value = c.x == null ? 0.5 : c.x;
    mk('横向位置', xr).oninput = () => { c.x = Number(xr.value); ED.dirty = true; edSave(); edSeek(ED.t, false); };
    const yr = E('input'); yr.type = 'range'; yr.min = '0'; yr.max = '1'; yr.step = '0.01'; yr.value = c.y == null ? 0.84 : c.y;
    mk('纵向位置', yr).oninput = () => { c.y = Number(yr.value); ED.dirty = true; edSave(); edSeek(ED.t, false); };
    const op = E('input'); op.type = 'range'; op.min = '0'; op.max = '1'; op.step = '0.01'; op.value = c.opacity == null ? 0.92 : c.opacity;
    mk('不透明度', op).oninput = () => { c.opacity = Number(op.value); ED.dirty = true; edSave(); edSeek(ED.t, false); };
  }

  if (c.type === 'video' || c.type === 'audio') {
    const vr = E('input'); vr.type = 'range'; vr.min = '0'; vr.max = '1'; vr.step = '0.01'; vr.value = c.volume == null ? 1 : c.volume;
    mk('音量', vr).oninput = () => { c.volume = Number(vr.value); ED.dirty = true; edSave(); edSeek(ED.t, false); };
    const sp = E('input'); sp.type = 'number'; sp.step = '0.05'; sp.min = '0.1'; sp.max = '8'; sp.value = c.speed || 1;
    mk('速度（倍）', sp).onchange = () => { c.speed = Math.max(0.1, Number(sp.value) || 1); ED.dirty = true; edSave(); edRenderAll(); };
    if (c.type === 'video') {
      const fit = E('select');
      for (const v of ['cover', 'contain', 'fill']) {
        const o = document.createElement('option'); o.value = v; o.textContent = v; if ((c.fit || 'cover') === v) o.selected = true; fit.appendChild(o);
      }
      mk('填充方式', fit).onchange = () => { c.fit = fit.value; ED.dirty = true; edSave(); edSeek(ED.t, false); };
      const ip = E('input'); ip.type = 'number'; ip.step = '0.1'; ip.min = '0'; ip.value = c.in || 0;
      mk('从第几秒开始用（in）', ip).onchange = () => { c.in = Math.max(0, Number(ip.value) || 0); ED.dirty = true; edSave(); edRenderAll(); };
    }
  }

  if (c.type === 'image') {
    const fit = E('select');
    for (const v of ['cover', 'contain', 'fill']) {
      const o = document.createElement('option'); o.value = v; o.textContent = v; if ((c.fit || 'cover') === v) o.selected = true; fit.appendChild(o);
    }
    mk('填充方式', fit).onchange = () => { c.fit = fit.value; ED.dirty = true; edSave(); edSeek(ED.t, false); };
    const op = E('input'); op.type = 'range'; op.min = '0'; op.max = '1'; op.step = '0.01'; op.value = c.opacity == null ? 1 : c.opacity;
    mk('不透明度', op).oninput = () => { c.opacity = Number(op.value); ED.dirty = true; edSave(); edSeek(ED.t, false); };
  }

  // 删除 + 复制（复制到本轨末尾，做等长片段时省一半操作）
  const rb = E('div', 'row2');
  const bDup = E('button', 'btn sm', '复制一份');
  bDup.onclick = () => {
    edSnapshot();
    const tr = ED.doc.tracks.find((x) => x.id === ED.sel.trId);
    const cp = JSON.parse(JSON.stringify(c));
    cp.id = 'c' + Date.now() + '-' + Math.floor(Math.random() * 999);
    cp.start = round3(Math.max(...tr.clips.map(clipEnd)));
    tr.clips.push(cp);
    ED.dirty = true; edSave(); edRenderAll(); edSelect(tr.id, cp.id);
  };
  const bDel = E('button', 'btn sm', '删除');
  bDel.style.color = 'var(--err)';
  bDel.onclick = () => edDeleteSel();
  rb.appendChild(bDup); rb.appendChild(bDel);
  box.appendChild(rb);

  // ★ 比剪映强的一点：选中片段直接跟 AI 说一句话让它改
  const aiWrap = E('div', 'f');
  aiWrap.style.marginTop = '14px';
  aiWrap.appendChild(E('label', null, '让 AI 改这一段'));
  const ai = E('div', 'ed-ai');
  const aiIn = E('input');
  aiIn.placeholder = '比如：字再大一点、慢一半、往左上挪';
  const aiGo = E('button', 'btn sm', '改');
  ai.appendChild(aiIn); ai.appendChild(aiGo);
  aiWrap.appendChild(ai);
  const aiHint = E('div');
  aiHint.style.cssText = 'color:var(--ink3);font-size:var(--f5);margin-top:6px;line-height:1.6';
  aiWrap.appendChild(aiHint);
  box.appendChild(aiWrap);
  const runAi = async () => {
    const q = aiIn.value.trim();
    if (!q) return;
    aiGo.disabled = true; aiHint.textContent = 'AI 正在看这一段…';
    try {
      const r = await edAiPatch(c, q);
      if (r.ok) { aiHint.textContent = '改好了：' + r.note; ED.dirty = true; await edSave(true); edRenderAll(); }
      else aiHint.textContent = '没改：' + r.note;
    } catch (e) { aiHint.textContent = '出错：' + ((e && e.message) || e); }
    aiGo.disabled = false;
  };
  aiGo.onclick = runAi;
  aiIn.onkeydown = (ev) => { if (ev.key === 'Enter') runAi(); };
}

function edDeleteSel() {
  if (!ED.sel) return;
  edSnapshot();
  const tr = ED.doc.tracks.find((x) => x.id === ED.sel.trId);
  if (!tr) return;
  tr.clips = tr.clips.filter((c) => c.id !== ED.sel.id);
  ED.sel = null;
  ED.dirty = true; edSave(); edRenderAll();
}

/* ── 让 AI 改这一段 ─────────────────────────────────────────────
   不发整条时间线（几万字），只发这一段 + 一句要求，让模型返回改后的
   字段 JSON。这样一句话改一个片段只要一两秒，而不是等它理解整个工程。 */
async function edAiPatch(c, want) {
  const M = window.riffcut.models ? await window.riffcut.models() : null;
  const payload = JSON.parse(JSON.stringify(c));
  delete payload.src;
  const sys = '你是剪辑软件里的参数修改器。用户会给你一个片段当前的参数 JSON，和一句修改要求。'
    + '你要返回修改后的 JSON。规则：'
    + '1. 只返回 JSON，不要任何解释、不要代码围栏。'
    + '2. 只改和用户要求相关的字段，其余字段原样保留（包括 id）。'
    + '3. 可用字段：文字片段 text/start/duration/size/color/x/y/opacity/fadeIn/fadeOut/bold；'
    + '视频音频 start/in/out/speed/volume/fit/opacity。'
    + '4. 数值范围：size 8~400（像素）、x/y 0~1（0.5 是居中，y 越小越靠上）、opacity 0~1、speed 0.1~8、volume 0~1。'
    + '5. 「大一点」按 +20%、「小一点」按 -20%、「慢一半」speed×0.5、「快一倍」speed×2、'
    + '「往左上挪」x-0.08 y-0.08、「居中」x=0.5、「贴底」y=0.9。';
  const usr = '当前参数：\n' + JSON.stringify(payload, null, 1) + '\n\n修改要求：' + want;

  // 走内核（它已经连着模型）；内核不在就退回工具的 models 通道
  try {
    const r = await window.riffcut.call('think', {
      about: '按用户要求修改一个剪辑片段的参数，返回 JSON。' + sys + '\n\n' + usr,
      depth: 'brief',
    });
    const raw = String((r && (r.text || r.error)) || '');
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, note: 'AI 没有返回能用的 JSON' };
    const next = JSON.parse(m[0]);
    const changed = [];
    for (const k of Object.keys(next)) {
      if (k === 'id' || k === 'src' || k === 'type') continue;
      if (JSON.stringify(next[k]) !== JSON.stringify(c[k])) { c[k] = next[k]; changed.push(k); }
    }
    if (!changed.length) return { ok: false, note: '没看出要改哪个字段，说得具体一点（比如「字改到 96」「慢一半」）' };
    return { ok: true, note: changed.join('、') };
  } catch (e) {
    return { ok: false, note: String((e && e.message) || e) };
  }
}

/* ── 整屏 ───────────────────────────────────────────────────────── */
async function screenEditPro(root) {
  edCss();
  root.innerHTML = '';
  const wrap = E('div', 'ed');

  const top = E('div', 'ed-top');
  const nm = E('div', 'nm', '剪辑台');
  const bSave = E('button', 'btn sm', '保存');
  const bPlay = E('button', 'btn sm', '播放'); bPlay.id = 'edPlayBtn';
  const tm = E('div', 'tm', '00:00 / 00:00'); tm.id = 'edTime';
  const bPrev = E('button', 'btn sm', '出预览');
  const bFin = E('button', 'btn pri sm', '出成片');
  const sp = E('div', 'sp');
  const zOut = E('button', 'btn gh sm', '－'); const zIn = E('button', 'btn gh sm', '＋');
  top.append(nm, bSave, bPlay, tm, sp, zOut, zIn, bPrev, bFin);

  const mid = E('div', 'ed-mid');
  // 左：素材池
  const left = E('div', 'ed-left');
  left.appendChild(E('div', 'hd', '素材'));
  const pool = E('div', 'ed-pool'); pool.id = 'edPool';
  left.appendChild(pool);

  // 中：预览
  const center = E('div', 'ed-center');
  const stage = E('div', 'ed-stage');
  const frame = E('div', 'ed-frame'); frame.id = 'edFrame';
  const txLayer = E('div'); txLayer.id = 'edTxLayer';
  txLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  frame.appendChild(txLayer);
  stage.appendChild(frame);
  center.appendChild(stage);

  // 右：属性
  const right = E('div', 'ed-right');
  right.appendChild(E('div', 'hd', '属性'));
  const insp = E('div', 'ed-insp'); insp.id = 'edInsp';
  right.appendChild(insp);

  mid.append(left, center, right);

  // 下：时间线
  const tl = E('div', 'ed-tl');
  const tlhd = E('div', 'ed-tlhd');
  const tlTip = E('span', null, '拖动片段改位置 · 拖右边缘改时长 · 空格播放 · Delete 删 · ⌘Z 撤销');
  const tlsp = E('div', 'sp');
  const bFit = E('button', 'btn gh sm', '适应窗口');
  tlhd.append(tlTip, tlsp, bFit);
  const tlbd = E('div', 'ed-tlbd');
  const lbs = E('div', 'ed-lbs'); lbs.id = 'edLbs';
  const scroll = E('div', 'ed-scroll'); scroll.id = 'edScroll';
  const ruler = E('div', 'ed-ruler'); ruler.id = 'edRuler';
  const lanes = E('div', 'ed-lanes'); lanes.id = 'edLanes';
  scroll.append(ruler, lanes);
  tlbd.append(lbs, scroll);
  tl.append(tlhd, tlbd);
  wrap.append(top, mid, tl);
  root.appendChild(wrap);
  edWireDrop(lanes);

  // 尺寸：预览框按工程比例，撑满可用高度
  const fitFrame = () => {
    if (!ED.doc) return;
    const pad = 28;
    const availW = Math.max(120, stage.clientWidth - pad);
    const availH = Math.max(120, stage.clientHeight - pad);
    const ar = (ED.doc.width || 1080) / (ED.doc.height || 1920);
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    frame.style.width = Math.round(w) + 'px';
    frame.style.height = Math.round(h) + 'px';
    edSeek(ED.t, false);
  };
  const fitPps = () => {
    const w = scroll.clientWidth || 900;
    ED.pps = Math.max(6, Math.min(240, (w - 30) / Math.max(1, edTotal())));
    edLanes();
  };
  new ResizeObserver(fitFrame).observe(stage);
  new ResizeObserver(() => { /* 窗口变宽时只调预览，不抢缩放 */ }).observe(scroll);

  // 接线
  bSave.onclick = async () => { ED.dirty = true; await edSave(true); bSave.textContent = '已保存'; setTimeout(() => (bSave.textContent = '保存'), 900); };
  bPlay.onclick = edTogglePlay;
  zIn.onclick = () => { ED.pps = Math.min(240, ED.pps * 1.4); edLanes(); };
  zOut.onclick = () => { ED.pps = Math.max(6, ED.pps / 1.4); edLanes(); };
  bFit.onclick = fitPps;
  ruler.addEventListener('mousedown', (ev) => {
    const r = ruler.getBoundingClientRect();
    const seek = (x) => edSeek((x - r.left) / ED.pps, false);
    seek(ev.clientX);
    const mv = (e2) => seek(e2.clientX);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  // 滚轮缩放：⌘ + 滚
  scroll.addEventListener('wheel', (ev) => {
    if (!ev.metaKey && !ev.ctrlKey) return;
    ev.preventDefault();
    ED.pps = Math.max(6, Math.min(240, ED.pps * (ev.deltaY < 0 ? 1.12 : 0.89)));
    edLanes();
  }, { passive: false });

  bPrev.onclick = async () => {
    bPrev.disabled = true; bPrev.textContent = '渲染中…';
    try {
      const r = await window.riffcut.tlPreview(ED.doc.name);
      if (!r.ok) { alert('出预览失败：\n' + r.error); return; }
      // 预览片直接替换画面 —— 这是最接近成片的确认方式
      edTogglePlayOff();
      frame.innerHTML = '';
      frame.appendChild(txLayer);
      const v = document.createElement('video');
      v.src = r.url; v.controls = true; v.autoplay = true;
      v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block';
      frame.appendChild(v); v.play().catch(() => {});
    } finally { bPrev.disabled = false; bPrev.textContent = '出预览'; }
  };
  bFin.onclick = async () => {
    if (!confirm('出成片会完整渲染一次（30 秒片约 1 分钟）。继续？')) return;
    bFin.disabled = true; bFin.textContent = '渲染中…';
    try {
      const r = await window.riffcut.call('generate', { project: ED.doc.name, final: 1 });
      alert(r.ok ? '已出片：\n' + String(r.text).slice(0, 700) : '失败：\n' + String(r.text || r.error));
    } finally { bFin.disabled = false; bFin.textContent = '出成片'; }
  };

  // 全局键 + 拖动
  const onKey = (ev) => {
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.key === ' ') { ev.preventDefault(); edTogglePlay(); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); edDeleteSel(); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); edSeek(ED.t - (ev.shiftKey ? 1 : 0.1), false); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); edSeek(ED.t + (ev.shiftKey ? 1 : 0.1), false); }
    else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? edRedo() : edUndo(); }
    else if (ev.key === 'Home') { ev.preventDefault(); edSeek(0, true); }
  };
  const onMove = (ev) => edDragMove(ev);
  const onUp = () => edDragUp();
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  // 离开这一屏要拆干净，否则切到别的屏还在响应空格
  root.addEventListener('ed:teardown', () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cancelAnimationFrame(ED.raf);
    ED.playing = false;
  }, { once: true });

  // 载入
  const list = await window.riffcut.tlList();
  if (!list.ok) { root.innerHTML = '<div class="ed-tip">读工程失败：' + list.error + '</div>'; return; }
  if (!list.items.length) {
    root.innerHTML = '<div class="ed-tip">还没有剪辑工程。<br>回到会话跟 AI 说一句「做一条 30 秒的片子」，它会建一个。</div>';
    return;
  }
  const pick = (document.referrer && 0) || list.items[0].name;
  await edOpen(pick);
  nm.textContent = '剪辑台 · ' + ED.doc.name;
  fitFrame(); fitPps(); edRenderAll();

  async function edOpen(name) {
    const r = await window.riffcut.tlLoad(name);
    if (!r.ok) { alert('打开失败：' + r.error); return; }
    ED.doc = r.doc; ED.assets = r.assets || []; ED.sel = null; ED.t = 0;
    _vidState.forEach((s) => s.el.remove()); _vidState.clear();
    nm.textContent = '剪辑台 · ' + name;
    edRenderAll();
  }
  return { edOpen };
}

function edTogglePlayOff() {
  ED.playing = false;
  cancelAnimationFrame(ED.raf);
  const b = $$('#edPlayBtn'); if (b) b.textContent = '播放';
}

window.VeloraEditor = { screen: screenEditPro, state: ED };
