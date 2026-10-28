/**
 * NOCTURNE — 主控。
 *
 * 把 UI（HTML 面板）接到 Worker（推理）和 Sky（绘制）。
 * 数据流是单向的：面板改配置 -> 触发观测 -> worker 回结果 -> 画。
 */
import '../css/styles.css';
import { Sky } from './sky.js';
import {
  splitText,
  buildTsneInput,
  buildConstellationLinks,
  gravityRelax,
  meanVector,
  rankBySimilarity,
} from './kernel.js';

/**
 * 全局兜底。
 *
 * 模块体在装配阶段抛异常时，后面的 bootEngine() 就不会执行，页面安静地
 * 停在 Standby —— 排查时只能靠猜。这里把任何未捕获异常都落到幕布上，
 * 让失败自己说话。
 */
window.addEventListener('error', (e) => {
  const d = `${e.message || 'unknown'} @ ${e.filename || '?'}:${e.lineno || 0}`;
  if (window.__nocturne) window.__nocturne.log('FATAL', d);
  const c = document.getElementById('curtain');
  if (c) {
    c.classList.remove('is-gone');
    c.classList.add('has-error');
    const s = document.getElementById('curtain-status');
    const t = document.getElementById('curtain-detail');
    if (s) s.textContent = 'Script error';
    if (t) t.textContent = d;
  }
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  const d = String((r && r.stack) || (r && r.message) || r);
  if (window.__nocturne) window.__nocturne.log('FATAL', 'rejection: ' + d);
});

const $ = (id) => document.getElementById(id);

/** huggingface.co -> huggingface.co；镜像站显示成 hf-mirror.com；本地显示成 local */
const hostLabel = (host) => {
  const s = String(host || '');
  if (s.startsWith('models/')) return 'local weights';
  return s.replace(/^https?:\/\//, '');
};

/**
 * 推理线程。
 *
 * 必须是 classic worker（不是 module）：ONNX Runtime 在浏览器里靠
 * importScripts() 拉它的 glue 代码，而 module worker 禁用 importScripts，
 * 一进模型加载就抛 "Module scripts don't support importScripts()"。
 * Webpack 5 会把 worker 打成独立 chunk，这条路是通的。
 */
/**
 * 推理线程:。
 *
 * 必须是 classic worker（不是 module）：ONNX Runtime 在浏览器里靠
 * importScripts() 拉它的 glue 代码，而 module worker 禁用 importScripts，
 * 一进模型加载就抛 "Module scripts don't support importScripts()"。
 * Webpack 5 会把 worker 打成独立 chunk，这条路是通的。
 */
const worker = new Worker(new URL('./worker.js', import.meta.url));

/**
 * 诊断轨迹。worker 内部的错误不会冒泡到 window.onerror——
 * 没有这层记录，加载失败会表现成"永远停在 Standby"却查不到原因。
 * 控制台里随时可以 `window.__nocturne.trace` 看完整收发流水。
 */
window.__nocturne = {
  trace: [],
  worker,
  state: null,
  sky: null,
  log(kind, detail) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${kind}${detail ? ' ' + detail : ''}`;
    this.trace.push(line);
    if (this.trace.length > 400) this.trace.shift();
    if (/^(ERR|FATAL)/.test(kind)) console.error('NOCTURNE', line);
  },
};

// 包一层 postMessage 只为了记流水，不改变语义
const __rawPost = worker.postMessage.bind(worker);
worker.postMessage = (m) => {
  window.__nocturne.log('OUT', m.type);
  return __rawPost(m);
};

worker.addEventListener('error', (e) => {
  // importScripts / chunk 404 / WASM 失败都从这里出来，且不会冒泡到 window
  window.__nocturne.log('FATAL', (e && e.message) || 'worker error');
});

/** 星图 */
const sky = new Sky($('sky'));

/** 当前会话状态 */
const state = {
  model: null,
  chunks: [],
  ready: false,
  busy: false,
  lastQuery: '',
  dim: 0,
  elapsed: 0,
  linkCount: 0,
};
window.__nocturne.state = state;
window.__nocturne.sky = sky;

/* ---------------- 小工具 ---------------- */

let noticeTimer = null;
function notice(msg) {
  const el = $('notice');
  el.textContent = msg;
  el.classList.add('is-on');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

function curtain(status, progress, opts = {}) {
  const c = $('curtain');
  if (status !== null) $('curtain-status').textContent = status;
  if (progress !== null) $('curtain-bar').style.width = progress + '%';
  if (opts.error) {
    c.classList.add('has-error');
    $('curtain-detail').textContent = opts.detail || '';
    $('curtain-status').textContent = status || 'Failed';
  }
  if (opts.done) c.classList.add('is-gone');
  if (opts.show) c.classList.remove('is-gone');
}

/* ---------------- 面板手风琴 ---------------- */

Array.from(document.querySelectorAll('.panel__head')).forEach((head) => {
  head.addEventListener('click', () => {
    const panel = head.parentElement;
    const isOpen = panel.classList.contains('is-open');
    head.classList.toggle('is-open', !isOpen);
    panel.classList.toggle('is-open', !isOpen);
  });
});
// 注意：$ 是 getElementById 的别名，只接受 id，传选择器必然返回 null。
const firstPanel = document.querySelector('.panel[data-panel="text"]');
if (firstPanel) firstPanel.classList.add('is-open');

/* ---------------- 参数滑杆读数 ---------------- */

$('threshold').addEventListener('input', (e) => {
  $('v-threshold').textContent = (e.target.value / 100).toFixed(2);
});
$('iters').addEventListener('input', (e) => {
  $('v-iters').textContent = e.target.value;
});
$('seed').addEventListener('input', (e) => {
  $('v-seed').textContent = e.target.value;
});
$('links').addEventListener('change', (e) => { sky.opts.links = e.target.checked; });
$('labels').addEventListener('change', (e) => { sky.opts.labels = e.target.checked; });
$('grain').addEventListener('change', (e) => { sky.opts.grain = e.target.checked; });

/* ---------------- 星图交互 ---------------- */

const whisper = $('whisper');

$('sky').addEventListener('mousemove', (e) => {
  const hit = sky.hit(e.clientX, e.clientY);
  sky.hover = hit;
  if (hit) {
    whisper.querySelector('.q').textContent = hit.text;
    whisper.querySelector('.m').textContent = `Similarity ${hit.similarity.toFixed(4)}`;
    // 靠边时翻转，别跑出屏幕
    const w = 310;
    const x = Math.min(e.clientX + 18, window.innerWidth - w - 24);
    const y = Math.min(e.clientY + 18, window.innerHeight - 130);
    whisper.style.left = x + 'px';
    whisper.style.top = y + 'px';
    whisper.classList.add('is-on');
  } else {
    whisper.classList.remove('is-on');
  }
});

$('sky').addEventListener('mouseleave', () => {
  sky.hover = null;
  whisper.classList.remove('is-on');
});

$('sky').addEventListener('click', (e) => {
  const hit = sky.hit(e.clientX, e.clientY);
  sky.selected = hit && hit !== sky.selected ? hit : null;
});

let drag = null;
$('sky').addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, y: e.clientY, vx: sky.view.x, vy: sky.view.y };
  $('sky').classList.add('grabbing');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  sky.view.x = drag.vx + (e.clientX - drag.x);
  sky.view.y = drag.vy + (e.clientY - drag.y);
});
window.addEventListener('mouseup', () => {
  drag = null;
  $('sky').classList.remove('grabbing');
});

$('sky').addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0016);
  const before = sky.toWorld(e.clientX, e.clientY);
  sky.view.k = Math.max(0.05, Math.min(sky.view.k * k, 60));
  const after = sky.toWorld(e.clientX, e.clientY);
  sky.view.x += (after.x - before.x) * sky.view.k;
  sky.view.y += (after.y - before.y) * sky.view.k;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    observe();
  }
  if (e.code === 'Escape') {
    Array.from(document.querySelectorAll('.panel')).forEach((p) => p.classList.remove('is-open'));
    Array.from(document.querySelectorAll('.panel__head')).forEach((h) => h.classList.remove('is-open'));
    sky.selected = null;
  }
});

/* ---------------- Worker 消息 ---------------- */

/** 一次性等待表：`once()` 挂在这里，不抢主 handler。 */
const waiters = [];

/**
 * 主 handler 用 addEventListener，不用 onmessage 赋值。
 *
 * 原因：本文件里曾经给 worker.onmessage 赋过两次值（诊断钩子 + 主 handler），
 * 后一次把前一次覆盖掉，消息只走一条路。addEventListener 是累加的，
 * 诊断、等待表、主逻辑三者互不干扰 —— 这也是排查时最省命的写法。
 */
worker.addEventListener('message', (ev) => {
  const msg = ev.data;
  window.__nocturne.trace.push(
    `[${new Date().toISOString().slice(11, 19)}] IN ${msg && msg.type}`
  );

  // 分派给等待者（命中即消费，其余仍走主 handler）
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].type === msg.type) {
      const w = waiters.splice(i, 1)[0];
      w.resolve(msg);
    }
  }

  switch (msg.type) {
    case 'error': {
      // worker 已经把错误捕获过了，这里必须落到幕布上。
      // 缺这个分支的后果是：模型源全挂了，页面却安静地停在 Standby。
      const detail = `${msg.stage || 'unknown'}: ${msg.message || '未提供原因'}`;
      window.__nocturne.log('FATAL', detail);
      state.busy = false;
      curtain('Engine failed', 0, { error: true, detail });
      break;
    }
    case 'source': {
      // 正在尝试第 i 个模型源
      curtain('Contacting ' + hostLabel(msg.host), 3);
      break;
    }
    case 'sourceRetry': {
      curtain('Source unreachable · switching to ' + hostLabel(msg.to), 3);
      window.__nocturne.log('RETRY', `${msg.from} -> ${msg.to}`);
      break;
    }
    case 'sourceLocked': {
      window.__nocturne.log('SRC', msg.host);
      break;
    }
    case 'download': {
      const d = msg.data;
      if (d.status === 'progress') {
        // 只跟主模型权重，其它小文件忽略
        if (!/\.onnx$/.test(d.file)) break;
        curtain('Fetching weights · ' + d.file.split('/').pop(), Math.round(d.progress));
      } else if (d.status === 'ready') {
        curtain('Compiling graph', 100);
      }
      break;
    }
    case 'ready': {
      state.ready = true;
      state.model = msg.model;
      $('col-model').textContent = msg.model.split('/').pop();
      $('r-model').textContent = msg.model;
      curtain(null, 100, { done: true });
      notice('引擎就绪 · ' + msg.model.split('/').pop());
      break;
    }
    case 'embedProgress': {
      curtain(`Embedding ${msg.done}/${msg.total}`, Math.round((msg.done / msg.total) * 100));
      break;
    }
    case 'embedded': {
      // 后续流程由 observe() 显式驱动，这里不做串联，
      // 否则两条流水线会重复发 t-SNE。
      break;
    }
    case 'meanEmbedding': {
      if (msg.vector) {
        state.dim = msg.vector.length;
        $('g-dim').textContent = String(state.dim);
      }
      // 有种子时种子本身就是引力源，直接降维；
      // 无种子时用全文重心顶上。
      if (state.lastQuery) {
        runTsne();
      } else if (msg.vector) {
        worker.postMessage({ type: 'setQuery', vector: msg.vector });
      } else {
        notice('算不出重心');
        curtain(null, 100, { done: true });
        state.busy = false;
      }
      break;
    }
    case 'tsne': {
      paint(msg.plotDataArray, msg.elapsed);
      state.busy = false;
      break;
    }
    case 'tokens': {
      $('r-tokens').textContent = String(msg.tokens.length);
      break;
    }
    case 'error': {
      state.busy = false;
      curtain(msg.stage + ' failed', null, { error: true, detail: msg.message });
      break;
    }
    default:
      break;
  }
});

worker.addEventListener('error', (e) => {
  state.busy = false;
  const detail = e.message || String(e);
  window.__nocturne.log('FATAL', 'worker: ' + detail);
  curtain('Worker crashed', null, { error: true, detail });
});

/* ---------------- 观测流程 ---------------- */

/**
 * 一次完整观测：切块 -> 嵌入 -> 查询向量 -> t-SNE -> 画。
 */
async function observe() {
  if (state.busy) return;
  const raw = $('source').value.trim();
  if (!raw) {
    notice('先放一段文字');
    return;
  }
  if (!state.ready) {
    notice('先装载引擎');
    return;
  }

  state.busy = true;
  state.chunks = splitText(raw);
  if (!state.chunks.length) {
    notice('切不出任何句子');
    state.busy = false;
    return;
  }

  curtain(null, null, { show: true });
  curtain('Splitting ' + state.chunks.length + ' passages', 4);
  $('r-chunks').textContent = String(state.chunks.length);

  const q = $('query').value.trim();
  state.lastQuery = q;

  // 无论有没有种子，先把全部句子嵌一遍——相似度要对每一句都算得出来。
  curtain('Embedding ' + state.chunks.length + ' passages', 8);
  await once('embedded', { type: 'embedBatch', texts: state.chunks });

  worker.postMessage({ type: 'meanEmbedding' });
  const mean = await once('meanEmbedding');
  if (mean.vector) {
    state.dim = mean.vector.length;
    $('g-dim').textContent = String(state.dim);
  }

  if (q) {
    curtain('Embedding seed', 92);
    await once('query', { type: 'query', text: q });
  } else if (mean.vector) {
    // 无种子：全文重心顶上，充当引力源
    curtain('Seeding from centroid', 94);
    worker.postMessage({ type: 'setQuery', vector: mean.vector });
    await once('query');
  } else {
    notice('算不出重心');
    state.busy = false;
    curtain(null, 100, { done: true });
    return;
  }

  runTsne();
}

/** 挂一个等待者，不发送任何消息。用于「已经发出去的请求」的回包。 */
function waitFor(type) {
  return new Promise((resolve) => {
    waiters.push({ type, resolve });
  });
}

/** 发一条 worker 消息，等一个指定类型的回复。不覆盖主 handler。 */
function once(type, payload) {
  if (payload === undefined) return waitFor(type);
  return new Promise((resolve) => {
    waiters.push({ type, resolve });
    worker.postMessage(payload);
  });
}

function runTsne() {
  curtain('Collapsing dimensions', 100);
  worker.postMessage({
    type: 'tsne',
    opts: {
      iterations: parseInt($('iters').value, 10),
      threshold: parseFloat($('threshold').value) / 100,
      seed: parseInt($('seed').value, 10),
    },
  });
}

/**
 * 把 t-SNE 结果变成星星，松弛重叠，画出来，更新读数。
 * @param {{x:number,y:number,text:string,similarity:number}[]} points
 * @param {number} elapsed
 */
function paint(points, elapsed) {
  const t0 = performance.now();
  const stars = points.map((p, i) => ({
    id: i,
    x: p.x,
    y: p.y,
    text: p.text,
    label: p.label || p.text,
    similarity: p.similarity,
    r: 1.6 + Math.max(0, p.similarity) * 4.4,
  }));
  if (!stars.length) {
    notice('没有星星越过门槛 · 调低 Legend 里的相似度门槛');
    curtain(null, 100, { done: true });
    return;
  }

  gravityRelax(stars, { iterations: 26, minGap: 2.2, strength: 0.42 });
  const links = buildConstellationLinks(stars, {
    autoScale: true,
    minSimilarity: 0.25,
  });

  sky.setStars(stars, { links: links.map((l) => ({ a: l.ai, b: l.bi })) });

  state.linkCount = links.length;
  state.elapsed = elapsed ?? Math.round(performance.now() - t0);

  const top = rankBySimilarity(stars);
  $('g-stars').textContent = String(stars.length);
  $('g-dim').textContent = state.dim ? String(state.dim) : '—';
  $('g-time').textContent = state.elapsed + 'ms';
  $('r-links').textContent = String(links.length);
  $('r-time').textContent = state.elapsed + ' ms';
  $('r-dim').textContent = state.dim ? String(state.dim) : '—';
  $('r-chunks').textContent = String(state.chunks.length);

  if (top.length) {
    $('r-model').textContent = state.model || '—';
  }

  curtain(null, 100, { done: true });
  notice(`观测完成 · ${stars.length} 星 / ${links.length} 引线`);
}

/* ---------------- 按钮 ---------------- */

$('btn-weave').addEventListener('click', observe);

$('btn-load').addEventListener('click', () => {
  curtain(null, null, { show: true });
  curtain('Contacting hub', 2);
  worker.postMessage({
    type: 'load',
    model_name: $('model').value,
    quantized: $('quantized').checked,
  });
});

$('btn-clear').addEventListener('click', () => {
  $('source').value = '';
  notice('已清空');
});

$('btn-query').addEventListener('click', observe);

$('btn-relayout').addEventListener('click', () => {
  $('seed').value = String(Math.floor(Math.random() * 999) + 1);
  $('v-seed').textContent = $('seed').value;
  observe();
});

$('btn-export').addEventListener('click', () => {
  const payload = {
    nocturne: 1,
    model: state.model,
    seedText: state.lastQuery,
    dim: state.dim,
    elapsed_ms: state.elapsed,
    stars: sky.stars.map((s) => ({
      x: +s.x.toFixed(4),
      y: +s.y.toFixed(4),
      r: +s.r.toFixed(3),
      similarity: +s.similarity.toFixed(5),
      text: s.text,
    })),
    links: sky.links,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nocturne-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  notice('星图已导出');
});

/* ---------------- 文本拖入 ---------------- */

const dropzone = document.body;
['dragenter', 'dragover'].forEach((t) =>
  dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    e.stopPropagation();
  })
);
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!/\.(txt|md|markdown)$/i.test(file.name)) {
    notice('只收 .txt / .md');
    return;
  }
  const text = await file.text();
  $('source').value = text;
  notice(`载入 ${file.name} · ${text.length} 字`);
});

/* ---------------- 开场 ---------------- */

// 先画一层空坐标格，让幕布后面不是纯黑
curtain('Standby', 0);

/**
 * 装载引擎。
 *
 * 必须晚于本模块全部副作用执行完 —— 否则 postMessage 会在主 handler
 * 挂上前发出，worker 的回包无人接收，页面永久停在 Standby。
 */
function bootEngine() {
  try {
    curtain('Loading engine…', 1);
    const sel = $('model');
    if (!sel) throw new Error('#model 元素缺失，无法得知要装载哪个模型');
    worker.postMessage({
      type: 'load',
      model_name: sel.value || 'Xenova/all-MiniLM-L6-v2',
      quantized: true,
      // worker 是独立 chunk，拿不到 entry 的 publicPath；
      // 站点部署在子路径时（GitHub Pages 项目站），本地权重必须带前缀才对。
      local_base: __webpack_public_path__, // eslint-disable-line no-undef
    });
  } catch (err) {
    // 装载失败必须让用户看见原因，而不是留一块死黑幕布。
    const detail = String((err && err.stack) || (err && err.message) || err);
    window.__nocturne.log('FATAL', detail);
    curtain('Engine failed to start', 0, { error: true, detail });
  }
}

// 直接同步装载。
//
// 不能用 requestAnimationFrame / setTimeout 延后：标签页在后台时
// rAF 完全不触发、定时器被节流到每分钟一次，引擎就永远装不上，
// 用户切回来看到的是一块死幕布。
// 此时 worker.onmessage 已在文件前段绑定完毕，同步调用是安全的。
bootEngine();
