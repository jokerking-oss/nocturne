/**
 * NOCTURNE — 推理线程。
 *
 * 模型加载、嵌入、t-SNE 全部在这里跑，主线程只负责画。
 * 协议是双向消息：index -> worker 发指令，worker -> index 回结果与进度。
 */
import { pipeline, AutoTokenizer, cos_sim, env } from '@xenova/transformers';
import init, { tSNE } from 'wasm-bhtsne';

/**
 * 模型来源。
 *
 * 三种取法，按顺序尝试：
 *   1. 同源本地 models/<id>/  —— 权重随站点一起发布时完全离线可用
 *   2. huggingface.co         —— 官方 hub
 *   3. hf-mirror.com          —— 官方 hub 不可达时的镜像
 *
 * 之所以要本地优先：企业网络、离线演示、录屏这些场景下外网根本不通，
 * 而"模型装不上"在界面上表现为一块死幕布，用户无从判断是网络问题还是产品坏了。
 *
 * 本地前缀由主线程随 load 消息传进来：worker 是独立 chunk，拿不到
 * entry 的 __webpack_public_path__，而 GitHub Pages 项目站点挂在 /<repo>/ 下，
 * 写死 'models/' 会在线上 404。
 */
let localPrefix = 'models/';
const MODEL_HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];

env.useBrowserCache = true;
env.remoteHost = MODEL_HOSTS[0];

// 诊断信号：worker 一旦真正跑起来就置位。
// worker 内的异常不冒泡到 window.onerror，没有这些标记就只能靠猜。
self.__WORKER_ALIVE__ = true;
self.__WORKER_SEEN__ = [];
self.__WORKER_ERRORS__ = [];

self.addEventListener('error', (e) => {
  self.__WORKER_ERRORS__.push('error: ' + (e.message || 'unknown'));
});
self.addEventListener('unhandledrejection', (e) => {
  self.__WORKER_ERRORS__.push('reject: ' + String((e.reason && e.reason.message) || e.reason));
});

init();

/** @type {Object<string, number[]>} text -> embedding 缓存 */
let embeddingsDict = {};
/** @type {*} 嵌入模型管线 */
let embedder = null;
/** @type {*} 仅分词器（token 计数） */
let tokenizer = null;
/** @type {number[]|null} 当前查询向量 */
let queryEmbedding = null;
/** @type {string} 当前模型 HUB id */
let modelId = '';

/**
 * 嵌入一段文本。命中缓存直接返回。
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
  if (text in embeddingsDict) return embeddingsDict[text];
  const out = await embedder(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(out.data);
  embeddingsDict[text] = vec;
  return vec;
}

/**
 * 装载嵌入模型。逐个 host 尝试，全部失败才抛错。
 *
 * 为什么要重试：huggingface.co 在部分网络下直接连不上（连接超时，
 * 不是 404），此时换镜像站通常能通。用户看到的应该是"正在换源"，
 * 而不是一块永久卡住的幕布。
 *
 * @param {string} modelName
 * @param {boolean} quantized
 */
async function loadEmbedder(modelName, quantized = true) {
  embeddingsDict = {};
  modelId = modelName;

  /**
   * 依次尝试的源。本地排第一：权重随站点发布时不受任何网络影响。
   * 每一项是 { label, host, local }。
   */
  const sources = [
    { label: localPrefix + modelName, host: null, local: true },
    ...MODEL_HOSTS.map((h) => ({ label: h, host: h, local: false })),
  ];

  let lastErr = null;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    try {
      self.postMessage({ type: 'source', host: src.label, index: i, total: sources.length });
      env.allowLocalModels = src.local;
      env.allowRemoteModels = !src.local;
      if (src.local) {
        // transformers.js 默认 localModelPath 是 '/models/'，写死在域名根；
        // 子路径部署时必须显式指到 <publicPath>models/。
        env.localModelPath = localPrefix;
      } else {
        env.remoteHost = src.host;
      }

      tokenizer = await AutoTokenizer.from_pretrained(modelName);
      embedder = await pipeline('feature-extraction', modelName, {
        quantized,
        progress_callback: (data) => {
          self.postMessage({ type: 'download', data, host: src.label });
        },
      });
      self.postMessage({ type: 'sourceLocked', host: src.label });
      return;
    } catch (err) {
      lastErr = err;
      const msg = String((err && err.message) || err);
      self.__WORKER_ERRORS__.push(`source ${src.label} failed: ${msg}`);
      if (i < sources.length - 1) {
        self.postMessage({
          type: 'sourceRetry',
          from: src.label,
          to: sources[i + 1].label,
          message: msg,
        });
      }
    }
  }
  throw lastErr || new Error('所有模型源均不可用');
}

/**
 * 跑 t-SNE 并连同相似度一起回传。
 * @param {{iterations:number, threshold:number, seed:number}} opts
 */
function runTsne(opts) {
  const labels = Object.keys(embeddingsDict);
  const n = labels.length;
  if (n === 0 || !queryEmbedding) {
    self.postMessage({ type: 'tsne', plotDataArray: [] });
    return;
  }
  const t0 = performance.now();

  // Barnes-Hut 需要最小样本量，不足时用确定性随机补齐。
  const values = labels.map((k) => embeddingsDict[k]);
  const matrix = values.slice();
  const dim = values[0].length;
  let toPad = 0;
  if (n < 61) {
    let h = (opts.seed || 1) >>> 0;
    const rand = () => {
      h |= 0;
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    toPad = 61 - n;
    for (let i = 0; i < toPad; i++) {
      matrix.push(Array.from({ length: dim }, () => rand()));
    }
  }

  const encoder = new tSNE(matrix);
  const compressed = encoder.barnes_hut(opts.iterations || 500);

  const plotDataArray = [];
  for (let i = 0; i < n; i++) {
    const sim = cos_sim(queryEmbedding, embeddingsDict[labels[i]]);
    if (sim < (opts.threshold ?? -1)) continue;
    plotDataArray.push({
      x: compressed[i][0],
      y: compressed[i][1],
      label: labels[i],
      text: labels[i],
      similarity: sim,
    });
  }

  const elapsed = Math.round(performance.now() - t0);
  self.postMessage({ type: 'tsne', plotDataArray, elapsed, padded: toPad });
}

self.onmessage = async (event) => {
  const msg = event.data;
  self.__WORKER_SEEN__.push(msg && msg.type);
  switch (msg.type) {
    case 'load': {
      try {
        // 主线程带过来的部署前缀（GitHub Pages 项目站点是 /<repo>/）
        if (msg.local_base) {
          const b = String(msg.local_base);
          // transformers.js 会拼 <localModelPath><model_id>/...，结尾必须带斜杠
          localPrefix = (b.endsWith('/') ? b : b + '/') + 'models/';
        }
        await loadEmbedder(msg.model_name, msg.quantized !== false);
        self.postMessage({ type: 'ready', model: modelId });
      } catch (e) {
        self.postMessage({ type: 'error', stage: 'load', message: String(e && e.message || e) });
      }
      break;
    }
    case 'embedBatch': {
      try {
        const texts = msg.texts || [];
        const total = texts.length;
        for (let i = 0; i < total; i++) {
          await embed(texts[i]);
          self.postMessage({ type: 'embedProgress', done: i + 1, total });
        }
        self.postMessage({ type: 'embedded', count: total });
      } catch (e) {
        self.postMessage({ type: 'error', stage: 'embed', message: String(e && e.message || e) });
      }
      break;
    }
    case 'setQuery': {
      // 外部给一个向量当引力源（通常是全文重心）
      queryEmbedding = msg.vector;
      self.postMessage({ type: 'query', embedding: queryEmbedding, synthetic: true });
      break;
    }
    case 'query': {
      try {
        queryEmbedding = await embed(msg.text);
        self.postMessage({ type: 'query', embedding: queryEmbedding });
      } catch (e) {
        self.postMessage({ type: 'error', stage: 'query', message: String(e && e.message || e) });
      }
      break;
    }
    case 'tsne': {
      try {
        runTsne(msg.opts || {});
      } catch (e) {
        self.postMessage({ type: 'error', stage: 'tsne', message: String(e && e.message || e) });
      }
      break;
    }
    case 'tokens': {
      try {
        if (!tokenizer) {
          tokenizer = await AutoTokenizer.from_pretrained(msg.model_name || modelId);
        }
        const ids = tokenizer(msg.text).input_ids.data;
        self.postMessage({ type: 'tokens', tokens: Array.from(ids) });
      } catch (e) {
        self.postMessage({ type: 'error', stage: 'tokens', message: String(e && e.message || e) });
      }
      break;
    }
    case 'meanEmbedding': {
      const vals = Object.values(embeddingsDict);
      if (!vals.length) {
        self.postMessage({ type: 'meanEmbedding', vector: null });
        break;
      }
      const dim = vals[0].length;
      const acc = new Array(dim).fill(0);
      for (const v of vals) for (let i = 0; i < dim; i++) acc[i] += v[i];
      self.postMessage({ type: 'meanEmbedding', vector: acc.map((s) => s / vals.length) });
      break;
    }
    case 'reset': {
      embeddingsDict = {};
      queryEmbedding = null;
      self.postMessage({ type: 'reset' });
      break;
    }
    default:
      break;
  }
};
