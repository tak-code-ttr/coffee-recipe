import { createBackend, isCloud } from './store.js';

const $app = document.getElementById('app');
let store;
let user = null;
let unsubscribe = null;
let live = false;      // データ更新時に再描画してよい画面か（フォーム・タイマーは false）
let cleanup = null;    // 画面離脱時の後始末
let searchQuery = '';
const state = { beans: [], recipes: [], ready: false };

/* ================= 定義 ================= */

const BEAN_FIELDS = [
  { k: 'name', label: '豆の名称', required: true, placeholder: '例: エチオピア イルガチェフェ' },
  { k: 'origin', label: '生産地', list: true, placeholder: '例: エチオピア / ゲデオ' },
  { k: 'producer', label: '生産者', list: true },
  { k: 'station', label: '精製所', list: true },
  { k: 'altitude', label: '標高', placeholder: '例: 1,900–2,100m' },
  { k: 'process', label: '精製方法', list: true, presets: ['ウォッシュト', 'ナチュラル', 'ハニー', 'アナエロビック', 'スマトラ式'] },
  { k: 'variety', label: '品種', list: true, presets: ['ゲイシャ', 'ブルボン', 'ティピカ', 'カトゥーラ', 'SL28', 'エチオピア在来種'] },
  { k: 'roast', label: '焙煎', list: true, presets: ['浅煎り', '中浅煎り', '中煎り', '中深煎り', '深煎り'] },
  { k: 'shop', label: '販売店', list: true },
  { k: 'roastDate', label: '焙煎日', type: 'date' },
  { k: 'purchaseDate', label: '購入日', type: 'date' },
  { k: 'price', label: '価格', type: 'number', suffix: '円' },
  { k: 'amount', label: '内容量', type: 'number', suffix: 'g' },
  { k: 'memo', label: 'メモ', type: 'textarea' },
];

// 注湯の入力方法。保存は常に「各投の割合(%)」で、ほかの形式は入力時に換算する。
const POUR_MODES = [
  { k: 'pct', tab: '割合 %', head: '割合(%)' },
  { k: 'cumPct', tab: '累計 %', head: '累計(%)' },
  { k: 'g', tab: '湯量 g', head: '湯量(g)' },
  { k: 'cumG', tab: '累計 g', head: '累計(g)' },
];

const DEFAULT_POURS = [
  { sec: 0, pct: 20 }, { sec: 45, pct: 20 }, { sec: 90, pct: 20 }, { sec: 130, pct: 20 }, { sec: 170, pct: 20 },
];

/* ================= ユーティリティ ================= */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const r1 = (n) => Math.round(n * 10) / 10;
const fmtG = (n) => `${Math.round(n)}g`;
const fmtTime = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const stars = (n) => '★'.repeat(n || 0) + '☆'.repeat(5 - (n || 0));
const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
const findBean = (id) => state.beans.find((b) => b.id === id);
const findRecipe = (id) => state.recipes.find((r) => r.id === id);
const recipesOf = (beanId) => state.recipes.filter((r) => r.beanId === beanId);
const recipeTitle = (r) => r.name || `${r.dose ?? '-'}g · 1:${r.ratio ?? '-'}`;

function roastAge(date) {
  if (!date) return '';
  const d = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(date + 'T00:00:00')) / 86400000);
  return Number.isFinite(d) && d >= 0 ? `焙煎から${d}日` : '';
}

function calc(r) {
  const total = (num(r.dose) || 0) * (num(r.ratio) || 0);
  let cum = 0, cumPct = 0;
  const pours = (r.pours || []).map((p, i) => {
    const pct = num(p.pct) || 0;
    const g = total * pct / 100;
    cum += g;
    cumPct += pct;
    return { ...p, n: i + 1, g, cum, cumPct };
  });
  const pctSum = r1(pours.reduce((a, p) => a + (num(p.pct) || 0), 0));
  return { total, pours, pctSum };
}

// 過去に入力した値 + プリセットを候補にする
function suggestions(kind, key, presets = []) {
  const vals = state[kind].map((x) => x[key]).filter(Boolean);
  return [...new Set([...vals, ...presets])];
}
const datalist = (id, values) =>
  `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;

function saveDoc(kind, obj) {
  const now = Date.now();
  const doc = { ...obj, id: obj.id || store.newId(), createdAt: obj.createdAt || now, updatedAt: now };
  // オフライン時は Promise がすぐ解決しないため待たずに画面遷移する（ローカルには即時反映される）
  const list = state[kind];
  const i = list.findIndex((x) => x.id === doc.id);
  if (i >= 0) list[i] = doc; else list.push(doc);   // 同期の反映を待たずに画面へ反映
  store.save(kind, doc).catch((e) => alert('保存できませんでした: ' + e.message));
  return doc.id;
}
function removeDoc(kind, id) {
  state[kind] = state[kind].filter((x) => x.id !== id);
  store.remove(kind, id).catch((e) => alert('削除できませんでした: ' + e.message));
}

function topbar({ back, title, right = '' }) {
  return `<header class="topbar">
    <div class="tb-side">${back ? `<a class="back" href="${back}">‹ 戻る</a>` : ''}</div>
    <h1>${esc(title)}</h1>
    <div class="tb-side tb-right">${right}</div>
  </header>`;
}

const go = (hash) => { location.hash = hash; };
const replace = (hash) => { location.replace(hash); };

/* ================= ルーティング ================= */

function render(isRefresh = false) {
  if (cleanup) { cleanup(); cleanup = null; }
  live = false;
  if (!user) return viewLogin();
  if (!state.ready) { $app.innerHTML = '<div class="splash">読み込み中…</div>'; return; }

  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'bean' && p[1] === 'new') viewBeanForm(null);
  else if (p[0] === 'bean' && p[2] === 'edit') viewBeanForm(p[1]);
  else if (p[0] === 'bean' && p[2] === 'recipe' && p[3] === 'new') viewRecipeForm(null, p[1]);
  else if (p[0] === 'bean' && p[1]) viewBean(p[1]);
  else if (p[0] === 'recipe' && p[2] === 'edit') viewRecipeForm(p[1]);
  else if (p[0] === 'recipe' && p[2] === 'timer') viewTimer(p[1]);
  else if (p[0] === 'recipe' && p[1]) viewRecipe(p[1]);
  else if (p[0] === 'settings') viewSettings();
  else viewBeans();

  if (!isRefresh) window.scrollTo(0, 0);
}

function notFound() {
  $app.innerHTML = `${topbar({ back: '#/', title: '見つかりません' })}
    <main class="wrap"><p class="empty">データが見つかりません。削除された可能性があります。</p></main>`;
}

/* ================= ログイン ================= */

function viewLogin() {
  $app.innerHTML = `<main class="login">
    <img src="icons/icon.svg" alt="" class="login-icon">
    <h1>Coffee Recipe</h1>
    <p>Googleアカウントでログインすると、Mac・iPhone・iPadでレシピが同期されます。</p>
    <button class="btn primary" id="login">Googleでログイン</button>
  </main>`;
  document.getElementById('login').onclick = () =>
    store.login().catch((e) => alert('ログインできませんでした: ' + e.message));
}

/* ================= 豆一覧 ================= */

function viewBeans() {
  live = true;
  const beans = [...state.beans].sort(byUpdated);
  const cards = beans.map((b) => {
    const rs = recipesOf(b.id);
    const best = Math.max(0, ...rs.map((r) => r.rating || 0));
    const sub = [b.origin, b.process, b.roast].filter(Boolean).join(' · ');
    const search = [b.name, b.origin, b.producer, b.station, b.variety, b.process, b.roast, b.shop].join(' ').toLowerCase();
    const age = roastAge(b.roastDate);
    return `<a class="card" href="#/bean/${b.id}" data-search="${esc(search)}">
      <div class="card-title">${esc(b.name)}</div>
      ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
      <div class="card-meta"><span>レシピ ${rs.length}</span>
        ${best ? `<span class="stars">${stars(best)}</span>` : ''}
        ${age ? `<span>${age}</span>` : ''}</div>
    </a>`;
  }).join('');

  $app.innerHTML = `${topbar({ title: 'Coffee Recipe', right: `<a class="icon-btn" href="#/settings" aria-label="設定">設定</a>` })}
    <main class="wrap">
      ${!isCloud ? `<div class="notice">ローカルモード：データはこの端末のブラウザにだけ保存されています。同期するにはFirebaseを設定してください（README参照）。</div>` : ''}
      ${beans.length ? `<input class="search" type="search" placeholder="豆を検索（名称・産地・品種・販売店…）" value="${esc(searchQuery)}">` : ''}
      <div class="list">${cards || '<p class="empty">まだ豆が登録されていません。<br>「＋ 豆を追加」から始めましょう。</p>'}</div>
    </main>
    <a class="fab" href="#/bean/new">＋ 豆を追加</a>`;

  const input = $app.querySelector('.search');
  if (input) {
    const apply = () => {
      searchQuery = input.value;
      const q = searchQuery.trim().toLowerCase();
      $app.querySelectorAll('.card').forEach((c) => { c.hidden = q && !c.dataset.search.includes(q); });
    };
    input.oninput = apply;
    apply();
  }
}

/* ================= 豆の詳細 ================= */

function viewBean(id) {
  live = true;
  const b = findBean(id);
  if (!b) return notFound();

  const rows = BEAN_FIELDS.filter((f) => f.k !== 'name' && f.k !== 'memo' && b[f.k] !== '' && b[f.k] != null)
    .map((f) => {
      let v = b[f.k];
      if (f.k === 'price') v = `¥${Number(v).toLocaleString()}`;
      else if (f.suffix) v = `${v}${f.suffix}`;
      if (f.k === 'roastDate' && roastAge(b.roastDate)) v = `${v}（${roastAge(b.roastDate)}）`;
      return `<div class="kv"><dt>${f.label}</dt><dd>${esc(v)}</dd></div>`;
    }).join('');

  const recipes = recipesOf(id).sort((a, c) => (c.rating || 0) - (a.rating || 0) || byUpdated(a, c));
  const cards = recipes.map((r) => {
    const { total } = calc(r);
    const meta = [
      r.dose ? `${r.dose}g` : '', r.ratio ? `1:${r.ratio}` : '', total ? `湯量${fmtG(total)}` : '',
      r.temp ? `${r.temp}℃` : '', r.pours?.length ? `${r.pours.length}投` : '',
    ].filter(Boolean);
    const gear = [r.grinder && `${r.grinder}${r.grind ? ' ' + r.grind : ''}`, r.dripper].filter(Boolean).join(' / ');
    return `<a class="card" href="#/recipe/${r.id}">
      <div class="card-title">${esc(recipeTitle(r))} ${r.rating ? `<span class="stars">${stars(r.rating)}</span>` : ''}</div>
      <div class="chips">${meta.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>
      ${gear ? `<div class="card-sub">${esc(gear)}</div>` : ''}
    </a>`;
  }).join('');

  $app.innerHTML = `${topbar({ back: '#/', title: b.name, right: `<a class="icon-btn" href="#/bean/${id}/edit">編集</a>` })}
    <main class="wrap">
      ${rows ? `<dl class="panel kvs">${rows}</dl>` : ''}
      ${b.memo ? `<div class="panel memo">${esc(b.memo)}</div>` : ''}
      <div class="section-head"><h2>レシピ</h2><a class="btn small primary" href="#/bean/${id}/recipe/new">＋ レシピを追加</a></div>
      <div class="list">${cards || '<p class="empty">まだレシピがありません。</p>'}</div>
    </main>`;
}

/* ================= 豆の編集 ================= */

function viewBeanForm(id) {
  const bean = id ? findBean(id) : {};
  if (id && !bean) return notFound();

  const fields = BEAN_FIELDS.map((f) => {
    const v = esc(bean[f.k] ?? '');
    const listId = f.list ? `dl-${f.k}` : '';
    let control;
    if (f.type === 'textarea') control = `<textarea name="${f.k}" rows="3">${v}</textarea>`;
    else {
      const extra = f.type === 'number' ? 'inputmode="decimal" step="any" min="0"' : '';
      control = `<input name="${f.k}" type="${f.type || 'text'}" value="${v}" ${f.required ? 'required' : ''}
        ${listId ? `list="${listId}" autocomplete="off"` : ''} ${extra} placeholder="${esc(f.placeholder || '')}">`;
      if (f.suffix) control = `<div class="with-suffix">${control}<span>${f.suffix}</span></div>`;
    }
    return `<label class="field ${f.type === 'textarea' ? 'full' : ''}"><span>${f.label}${f.required ? ' *' : ''}</span>${control}
      ${listId ? datalist(listId, suggestions('beans', f.k, f.presets)) : ''}</label>`;
  }).join('');

  $app.innerHTML = `${topbar({ back: id ? `#/bean/${id}` : '#/', title: id ? '豆を編集' : '豆を追加' })}
    <main class="wrap">
      <form class="panel form" id="f">
        <div class="grid">${fields}</div>
        <div class="actions">
          ${id ? '<button type="button" class="btn danger" id="del">削除</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="btn" id="cancel">キャンセル</button>
          <button class="btn primary">保存</button>
        </div>
      </form>
    </main>`;

  const form = document.getElementById('f');
  form.onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = { ...bean };
    BEAN_FIELDS.forEach((f) => {
      const v = String(fd.get(f.k) ?? '').trim();
      data[f.k] = f.type === 'number' ? (num(v) ?? '') : v;
    });
    const newId = saveDoc('beans', data);
    replace(`#/bean/${newId}`);
  };
  document.getElementById('cancel').onclick = () => history.back();
  const del = document.getElementById('del');
  if (del) del.onclick = () => {
    const rs = recipesOf(id);
    if (!confirm(`「${bean.name}」を削除しますか？${rs.length ? `\nこの豆のレシピ${rs.length}件も削除されます。` : ''}`)) return;
    rs.forEach((r) => removeDoc('recipes', r.id));
    removeDoc('beans', id);
    replace('#/');
  };
}

/* ================= レシピ詳細 ================= */

function viewRecipe(id) {
  live = true;
  const r = findRecipe(id);
  if (!r) return notFound();
  const b = findBean(r.beanId);
  const { total, pours, pctSum } = calc(r);

  const specs = [
    ['グラインダー', r.grinder], ['挽き目', r.grind], ['ドリッパー', r.dripper], ['フィルター', r.filter],
    ['湯温', r.temp ? `${r.temp}℃` : ''], ['トータル時間', r.totalTime ? fmtTime(r.totalTime) : ''],
  ].filter(([, v]) => v);

  $app.innerHTML = `${topbar({ back: b ? `#/bean/${b.id}` : '#/', title: recipeTitle(r), right: `<a class="icon-btn" href="#/recipe/${id}/edit">編集</a>` })}
    <main class="wrap">
      ${b ? `<p class="crumb">${esc(b.name)}</p>` : ''}
      <section class="hero panel">
        <div><span class="hero-num">${r.dose ?? '-'}<small>g</small></span><span class="hero-label">豆</span></div>
        <div><span class="hero-num">1:${r.ratio ?? '-'}</span><span class="hero-label">レシオ</span></div>
        <div><span class="hero-num">${Math.round(total)}<small>g</small></span><span class="hero-label">総湯量</span></div>
      </section>
      ${specs.length ? `<dl class="panel kvs">${specs.map(([k, v]) => `<div class="kv"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
      <div class="section-head"><h2>注湯（${pours.length}投）</h2></div>
      <div class="panel table-wrap">
        <table class="pours">
          <thead><tr><th>投</th><th>開始</th><th>割合</th><th>累計%</th><th>湯量</th><th>累計</th></tr></thead>
          <tbody>${pours.map((p) => `<tr><td>${p.n}</td><td>${fmtTime(p.sec)}</td><td>${r1(num(p.pct) || 0)}%</td><td>${r1(p.cumPct)}%</td><td>${fmtG(p.g)}</td><td><b>${fmtG(p.cum)}</b></td></tr>`).join('')}</tbody>
        </table>
        ${pctSum !== 100 ? `<p class="warn">割合の合計が ${pctSum}% です（100%ではありません）</p>` : ''}
      </div>
      ${r.rating || r.memo ? `<div class="panel memo">${r.rating ? `<div class="stars big">${stars(r.rating)}</div>` : ''}${esc(r.memo || '')}</div>` : ''}
      <a class="btn primary block" href="#/recipe/${id}/timer">▶ このレシピで淹れる（タイマー）</a>
      <div class="actions">
        <button class="btn danger" id="del">削除</button>
        <span class="spacer"></span>
        <button class="btn" id="dup">複製</button>
      </div>
    </main>`;

  document.getElementById('del').onclick = () => {
    if (!confirm(`レシピ「${recipeTitle(r)}」を削除しますか？`)) return;
    removeDoc('recipes', id);
    replace(b ? `#/bean/${b.id}` : '#/');
  };
  document.getElementById('dup').onclick = () => {
    const copy = { ...structuredClone(r), id: undefined, createdAt: undefined, name: (r.name || recipeTitle(r)) + ' のコピー' };
    const newId = saveDoc('recipes', copy);
    go(`#/recipe/${newId}/edit`);
  };
}

/* ================= レシピ編集 ================= */

function viewRecipeForm(id, beanIdForNew) {
  const existing = id ? findRecipe(id) : null;
  if (id && !existing) return notFound();
  const last = [...state.recipes].sort(byUpdated)[0];
  const draft = existing ? structuredClone(existing) : {
    beanId: beanIdForNew, name: '', dose: 15, ratio: 15, temp: 92,
    grinder: last?.grinder || '', grind: '', dripper: last?.dripper || '', filter: last?.filter || '',
    pours: structuredClone(DEFAULT_POURS), totalTime: '', rating: 0, memo: '',
  };
  if (!draft.pours) draft.pours = [];
  const bean = findBean(draft.beanId);
  if (!bean) return notFound();

  const text = (k, label, list, ph = '') => `<label class="field"><span>${label}</span>
    <input name="${k}" value="${esc(draft[k] ?? '')}" placeholder="${esc(ph)}" ${list ? `list="dl-${k}" autocomplete="off"` : ''}>
    ${list ? datalist(`dl-${k}`, suggestions('recipes', k)) : ''}</label>`;
  const numberField = (k, label, suffix, prefix = '') => `<label class="field"><span>${label}</span>
    <div class="with-suffix">${prefix ? `<span>${prefix}</span>` : ''}<input name="${k}" type="number" inputmode="decimal" step="any" min="0" value="${esc(draft[k] ?? '')}"><span>${suffix}</span></div></label>`;

  $app.innerHTML = `${topbar({ back: existing ? `#/recipe/${id}` : `#/bean/${bean.id}`, title: existing ? 'レシピを編集' : 'レシピを追加' })}
    <main class="wrap">
      <p class="crumb">${esc(bean.name)}</p>
      <form class="form" id="f">
        <div class="panel">
          <label class="field full"><span>レシピ名</span><input name="name" value="${esc(draft.name || '')}" placeholder="例: 4:6メソッド（空欄なら自動）"></label>
          <div class="grid three">
            ${numberField('dose', 'グラム数（豆）', 'g')}
            ${numberField('ratio', 'レシオ', '', '1 :')}
            ${numberField('temp', '湯温', '℃')}
          </div>
          <p class="calc" id="total"></p>
        </div>
        <div class="panel grid">
          ${text('grinder', 'グラインダーの種類', true, '例: コマンダンテ C40')}
          ${text('grind', '挽き目', false, '例: 24クリック')}
          ${text('dripper', 'ドリッパー', true, '例: HARIO V60')}
          ${text('filter', 'フィルター', true, '例: V60 01 漂白')}
        </div>
        <div class="panel">
          <div class="section-head tight"><h2>注湯</h2><button type="button" class="btn small" id="even">割合を均等に</button></div>
          <div class="seg" id="mode" aria-label="注湯の入力方法">${POUR_MODES.map((m) => `<button type="button" data-mode="${m.k}">${m.tab}</button>`).join('')}</div>
          <div class="pour-head"><span>投</span><span>開始(秒)</span><span id="mode-head"></span><span>割合・湯量 / 累計</span><span></span></div>
          <div id="pours"></div>
          <button type="button" class="btn small block" id="add">＋ 1投追加</button>
          <p class="calc" id="pctsum"></p>
          <div class="grid">
            <label class="field"><span>トータル時間（落ち切り・任意）</span>
              <div class="with-suffix"><input name="totalTime" type="number" inputmode="numeric" min="0" value="${esc(draft.totalTime ?? '')}" placeholder="例: 210"><span>秒</span></div></label>
          </div>
        </div>
        <div class="panel">
          <div class="field full"><span>評価</span><div class="rating" id="rating"></div></div>
          <label class="field full"><span>メモ</span><textarea name="memo" rows="4" placeholder="味の印象、次回の調整など">${esc(draft.memo || '')}</textarea></label>
        </div>
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="btn" id="cancel">キャンセル</button>
          <button class="btn primary">保存</button>
        </div>
      </form>
    </main>`;

  const form = document.getElementById('f');
  const el = (k) => form.elements[k];
  const $pours = document.getElementById('pours');
  const readTop = () => { draft.dose = num(el('dose').value); draft.ratio = num(el('ratio').value); };

  let mode = 'pct';
  try { mode = localStorage.getItem('pourInputMode') || 'pct'; } catch { /* 保存不可の環境 */ }
  if (!POUR_MODES.some((m) => m.k === mode)) mode = 'pct';
  const usesGrams = () => mode === 'g' || mode === 'cumG';
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const modeValue = (p) => r1({ pct: num(p.pct) || 0, cumPct: p.cumPct, g: p.g, cumG: p.cum }[mode]);

  // 選択中の形式で入力された値を、その投の割合(%)に換算して反映する
  function applyValue(i, v) {
    const total = (num(draft.dose) || 0) * (num(draft.ratio) || 0);
    const pcts = draft.pours.map((p) => num(p.pct) || 0);
    const before = pcts.slice(0, i).reduce((a, b) => a + b, 0);
    const gToPct = (g) => (total ? (g / total) * 100 : null);
    const next = {
      pct: v,
      cumPct: v - before,
      g: gToPct(v),
      cumG: total ? gToPct(v) - before : null,
    }[mode];
    if (next == null) return;
    const diff = next - pcts[i];
    draft.pours[i].pct = round4(next);
    // 累計で入力したときは、次の投で差を吸収して後ろの投の累計を変えない
    if ((mode === 'cumPct' || mode === 'cumG') && draft.pours[i + 1]) {
      draft.pours[i + 1].pct = round4(pcts[i + 1] - diff);
    }
  }

  function updateCalc() {
    readTop();
    const { total, pours, pctSum } = calc(draft);
    document.getElementById('total').innerHTML = total ? `総湯量 <b>${fmtG(total)}</b>` : 'グラム数とレシオを入れると総湯量を計算します';
    pours.forEach((p, i) => {
      const input = $pours.querySelector(`input[data-f="val"][data-i="${i}"]`);
      if (input) {
        const off = usesGrams() && !total;
        input.disabled = off;
        input.placeholder = off ? '総湯量なし' : '';
        // 入力中の欄は書き換えない（カーソルが飛ぶため）
        if (input !== document.activeElement) input.value = off ? '' : modeValue(p);
      }
      const cell = $pours.querySelector(`[data-out="${i}"]`);
      if (cell) {
        cell.innerHTML = `${r1(num(p.pct) || 0)}% · ${fmtG(p.g)}<br><small>累計 ${r1(p.cumPct)}% · <b>${fmtG(p.cum)}</b></small>`;
        cell.classList.toggle('neg', (num(p.pct) || 0) < 0);
      }
      const t = $pours.querySelector(`[data-time="${i}"]`);
      if (t) t.textContent = fmtTime(num(p.sec) || 0);
    });
    const el = document.getElementById('pctsum');
    el.textContent = `割合の合計: ${pctSum}%`;
    el.classList.toggle('warn', pctSum !== 100);
  }

  function renderPours() {
    $pours.innerHTML = draft.pours.map((p, i) => `<div class="pour-row">
      <span class="pour-n">${i + 1}</span>
      <span class="pour-sec"><input type="number" inputmode="numeric" min="0" data-i="${i}" data-f="sec" value="${esc(p.sec ?? '')}"><small data-time="${i}"></small></span>
      <input type="number" inputmode="decimal" step="any" data-i="${i}" data-f="val">
      <span class="pour-out" data-out="${i}"></span>
      <button type="button" class="icon-x" data-del="${i}" aria-label="${i + 1}投目を削除">×</button>
    </div>`).join('') || '<p class="empty small">注湯がありません</p>';
    updateCalc();
  }

  const $mode = document.getElementById('mode');
  const renderMode = () => {
    $mode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    document.getElementById('mode-head').textContent = POUR_MODES.find((m) => m.k === mode).head;
  };
  $mode.onclick = (e) => {
    const k = e.target.dataset.mode;
    if (!k) return;
    mode = k;
    try { localStorage.setItem('pourInputMode', k); } catch { /* 保存不可の環境 */ }
    renderMode();
    updateCalc();
  };
  renderMode();

  $pours.oninput = (e) => {
    const { i, f } = e.target.dataset;
    if (i == null) return;
    const v = num(e.target.value);
    if (f === 'sec') draft.pours[i].sec = v;
    else if (v != null) applyValue(+i, v);
    updateCalc();
  };
  // 入力欄を離れたら表示を整える（丸めなど）
  $pours.addEventListener('focusout', () => setTimeout(updateCalc));
  $pours.onclick = (e) => {
    const d = e.target.dataset.del;
    if (d == null) return;
    draft.pours.splice(+d, 1);
    renderPours();
  };
  document.getElementById('add').onclick = () => {
    const lastP = draft.pours[draft.pours.length - 1];
    const used = draft.pours.reduce((a, p) => a + (num(p.pct) || 0), 0);
    draft.pours.push({ sec: lastP ? (num(lastP.sec) || 0) + 40 : 0, pct: Math.max(0, r1(100 - used)) });
    renderPours();
  };
  document.getElementById('even').onclick = () => {
    const n = draft.pours.length;
    if (!n) return;
    const each = Math.floor((100 / n) * 10) / 10;
    draft.pours.forEach((p, i) => { p.pct = i === n - 1 ? r1(100 - each * (n - 1)) : each; });
    renderPours();
  };
  el('dose').oninput = el('ratio').oninput = updateCalc;

  const $rating = document.getElementById('rating');
  const renderRating = () => {
    $rating.innerHTML = [1, 2, 3, 4, 5].map((n) =>
      `<button type="button" data-r="${n}" class="${n <= (draft.rating || 0) ? 'on' : ''}" aria-label="${n}">★</button>`).join('');
  };
  $rating.onclick = (e) => {
    const n = +e.target.dataset.r;
    if (!n) return;
    draft.rating = draft.rating === n ? 0 : n;   // 同じ星をもう一度押すと解除
    renderRating();
  };
  renderRating();
  renderPours();

  form.onsubmit = (e) => {
    e.preventDefault();
    readTop();
    const data = {
      ...draft,
      name: el('name').value.trim(),
      temp: num(el('temp').value) ?? '',
      grinder: el('grinder').value.trim(), grind: el('grind').value.trim(),
      dripper: el('dripper').value.trim(), filter: el('filter').value.trim(),
      totalTime: num(el('totalTime').value) ?? '',
      memo: el('memo').value.trim(),
      pours: draft.pours.map((p) => ({ sec: num(p.sec) ?? 0, pct: num(p.pct) ?? 0 })).sort((a, b) => a.sec - b.sec),
    };
    const newId = saveDoc('recipes', data);
    replace(`#/recipe/${newId}`);
  };
  document.getElementById('cancel').onclick = () => history.back();
}

/* ================= タイマー ================= */

let audioCtx = null;
function beep(freq = 880, dur = 0.12, vol = 0.25) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + dur);
}

function viewTimer(id) {
  const r = findRecipe(id);
  if (!r) return notFound();
  const { total, pours } = calc(r);
  const end = num(r.totalTime) || 0;

  $app.innerHTML = `${topbar({ back: `#/recipe/${id}`, title: recipeTitle(r) })}
    <main class="wrap timer">
      <p class="crumb center">${r.dose ?? '-'}g · 1:${r.ratio ?? '-'} · 総湯量 ${fmtG(total)}${r.temp ? ` · ${r.temp}℃` : ''}</p>
      <div class="t-clock" id="clock">0:00</div>
      <div class="t-now" id="now"></div>
      <div class="t-next" id="next"></div>
      <div class="t-bar"><div id="bar"></div></div>
      <ol class="t-pours" id="list">${pours.map((p, i) => `<li data-i="${i}">
        <span>${p.n}投目</span><span>${fmtTime(p.sec)}</span><span>+${fmtG(p.g)}</span><b>${fmtG(p.cum)}</b></li>`).join('')}</ol>
      <div class="t-controls">
        <button class="btn" id="reset">リセット</button>
        <button class="btn primary" id="toggle">スタート</button>
      </div>
      <p class="hint">注湯の3秒前からカウント音、開始時に長めの音が鳴ります（iPhoneはマナーモードだと鳴りません）。</p>
    </main>`;

  const $ = (s) => document.getElementById(s);
  let running = false, startAt = 0, acc = 0, lastIdx = -1, endBeeped = false, wakeLock = null;
  let counted = new Set();
  const elapsed = () => acc + (running ? (performance.now() - startAt) / 1000 : 0);

  function update() {
    const e = elapsed();
    let idx = -1;
    pours.forEach((p, i) => { if ((num(p.sec) || 0) <= e) idx = i; });
    if (!running && e === 0) idx = -1;

    if (running && idx > lastIdx) { beep(1320, 0.45, 0.35); navigator.vibrate?.(300); }
    if (running) lastIdx = Math.max(lastIdx, idx);

    const next = pours[idx + 1];
    const nextAt = next ? (num(next.sec) || 0) : end;
    const remain = nextAt - e;
    if (running && (next || end) && remain > 0 && remain <= 3) {
      const key = `${idx + 1}-${Math.ceil(remain)}`;
      if (!counted.has(key)) { counted.add(key); beep(880, 0.1, 0.2); }
    }
    if (running && end && e >= end && !endBeeped) {
      endBeeped = true; beep(988, 0.25, 0.3); setTimeout(() => beep(1318, 0.4, 0.3), 280);
    }

    $('clock').textContent = fmtTime(e);
    const cur = pours[idx];
    $('now').innerHTML = cur
      ? `${cur.n}投目　<b>累計 ${fmtG(cur.cum)}</b> まで`
      : (pours.length ? `スタートで 1投目（${fmtG(pours[0]?.cum || 0)}）` : '注湯が登録されていません');
    $('next').textContent = next
      ? (cur ? `次の${next.n}投目まで ${Math.ceil(remain)}秒` : '')
      : end ? (e < end ? `落ち切りまで ${Math.ceil(end - e)}秒` : '抽出終了 ☕') : (cur ? '落ち切りを待ちます' : '');

    const from = cur ? (num(cur.sec) || 0) : 0;
    const span = (next || end) ? nextAt - from : 0;
    $('bar').style.width = cur && span > 0 ? `${Math.min(100, ((e - from) / span) * 100)}%` : (cur && !next && !end ? '100%' : '0%');
    $('list').querySelectorAll('li').forEach((li, i) => {
      li.classList.toggle('done', i < idx);
      li.classList.toggle('current', i === idx);
    });
  }

  async function lock() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 非対応端末 */ }
  }
  const onVisible = () => { if (running && document.visibilityState === 'visible') lock(); };
  document.addEventListener('visibilitychange', onVisible);

  $('toggle').onclick = () => {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* 音なし */ } }
    audioCtx?.resume?.();
    if (running) { acc = elapsed(); running = false; wakeLock?.release?.(); wakeLock = null; }
    else { startAt = performance.now(); running = true; lock(); }
    $('toggle').textContent = running ? '一時停止' : '再開';
    update();
  };
  $('reset').onclick = () => {
    running = false; acc = 0; lastIdx = -1; endBeeped = false; counted = new Set();
    wakeLock?.release?.(); wakeLock = null;
    $('toggle').textContent = 'スタート';
    update();
  };

  const iv = setInterval(update, 100);
  update();
  cleanup = () => {
    clearInterval(iv);
    document.removeEventListener('visibilitychange', onVisible);
    wakeLock?.release?.();
  };
}

/* ================= 設定 ================= */

function viewSettings() {
  live = true;
  $app.innerHTML = `${topbar({ back: '#/', title: '設定' })}
    <main class="wrap">
      <div class="panel">
        <h2>アカウント</h2>
        <p>${esc(user.displayName || '')}${user.email ? `<br><small>${esc(user.email)}</small>` : ''}</p>
        <p class="muted">${isCloud ? 'Firebaseに保存され、同じアカウントでログインした端末と同期されます。オフラインでも使え、接続時に自動で同期します。'
          : 'ローカルモードです。データはこのブラウザにだけ保存されます。Firebaseを設定すると端末間で同期できます。'}</p>
        ${isCloud ? '<button class="btn" id="logout">ログアウト</button>' : ''}
      </div>
      <div class="panel">
        <h2>バックアップ</h2>
        <p class="muted">豆 ${state.beans.length}件・レシピ ${state.recipes.length}件</p>
        <div class="actions left">
          <button class="btn" id="export">書き出し（JSON）</button>
          <label class="btn">読み込み<input type="file" accept="application/json,.json" id="import" hidden></label>
        </div>
        <p class="muted small">ローカルモードで入力したデータを、Firebase設定後に読み込んで移行することもできます。同じIDのデータは上書きされます。</p>
      </div>
    </main>`;

  document.getElementById('logout')?.addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) store.logout();
  });
  document.getElementById('export').onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), beans: state.beans, recipes: state.recipes }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `coffee-recipe-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.getElementById('import').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const beans = Array.isArray(data.beans) ? data.beans : [];
      const recipes = Array.isArray(data.recipes) ? data.recipes : [];
      if (!confirm(`豆 ${beans.length}件・レシピ ${recipes.length}件を読み込みますか？`)) return;
      await Promise.all([
        ...beans.filter((b) => b.id).map((b) => store.save('beans', b)),
        ...recipes.filter((r) => r.id).map((r) => store.save('recipes', r)),
      ]);
      alert('読み込みました');
    } catch (err) {
      alert('読み込めませんでした: ' + err.message);
    }
    e.target.value = '';
  };
}

/* ================= 起動 ================= */

(async () => {
  try {
    store = await createBackend();
  } catch (e) {
    $app.innerHTML = `<div class="splash">起動できませんでした。<br>${esc(e.message)}</div>`;
    return;
  }
  store.watchUser((u) => {
    user = u;
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    state.ready = false; state.beans = []; state.recipes = [];
    if (!u) return render();
    render();
    unsubscribe = store.subscribe(u.uid, (data) => {
      state.beans = data.beans;
      state.recipes = data.recipes;
      const first = !state.ready;
      state.ready = true;
      if (first) render();
      else if (live) render(true);
    });
  });
  window.addEventListener('hashchange', () => render());
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
