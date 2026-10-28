/**
 * NOCTURNE — 内核。
 *
 * 纯函数集合：文本分块、向量运算、t-SNE 输入装配、星图布局。
 * 不碰 DOM、不依赖 Worker、可在 Node 下直接测试。
 * Worker 与渲染层都消费这里的输出。
 */

/** t-SNE 的最小样本数：低于此值 Barnes-Hut 会退化，需要补齐。 */
export const TSNE_MIN_SAMPLES = 61;

/**
 * 把文本切成语义块。按句末标点与换行切，剔除空白。
 * @param {string} text
 * @returns {string[]}
 */
export function splitText(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  return text
    .split(/(?<=[。．.!！?？;；\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 余弦相似度。零向量返回 0（不是 NaN——夜空容得下空星）。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    throw new Error('cosineSimilarity: vector length mismatch');
  }
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  if (ma === 0 || mb === 0) return 0;
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

/**
 * 一组向量的重心——星座的核心。
 * @param {number[][]} vectors
 * @returns {number[]|null}
 */
export function meanVector(vectors) {
  if (!vectors || vectors.length === 0) return null;
  const dim = vectors[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  return acc.map((s) => s / vectors.length);
}

/**
 * 确定性伪随机（mulberry32）。
 * 补向量必须是可复现的——同一段文本不该每次生成不同的宇宙。
 * @param {number} seed
 * @returns {() => number}
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 把 {text -> vector} 装配成 t-SNE 需要的矩阵，不足最小样本数则补齐。
 * @param {Object<string, number[]>} dict
 * @param {{minSamples?: number, seed?: number}} [opts]
 * @returns {{matrix: number[][], originalLength: number, labels: string[]}}
 */
export function buildTsneInput(dict, opts = {}) {
  const minSamples = opts.minSamples ?? TSNE_MIN_SAMPLES;
  const seed = opts.seed ?? 1;
  const labels = Object.keys(dict);
  const values = labels.map((k) => Array.from(dict[k]));
  const originalLength = values.length;
  const matrix = values.slice();

  if (originalLength === 0) {
    return { matrix: [], originalLength: 0, labels: [] };
  }

  const dim = values[0].length;
  if (originalLength < minSamples) {
    const rand = makeRandom(seed);
    const need = minSamples - originalLength;
    for (let i = 0; i < need; i++) {
      matrix.push(Array.from({ length: dim }, () => rand()));
    }
  }
  return { matrix, originalLength, labels };
}

/**
 * 把二维投影结果变成星点，按相似度过滤。
 * 超出 originalLength 的坐标是补齐产生的，丢弃，不画。
 * @param {number[][]} coords
 * @param {string[]} labels
 * @param {number[]} similarities
 * @param {{threshold?: number}} [opts]
 */
export function projectToStars(coords, labels, similarities, opts = {}) {
  const threshold = opts.threshold ?? 0;
  const n = Math.min(labels.length, coords.length);
  const stars = [];
  for (let i = 0; i < n; i++) {
    const sim = similarities[i];
    if (typeof sim === 'number' && sim < threshold) continue;
    stars.push({
      id: i,
      label: labels[i],
      text: labels[i],
      x: coords[i][0],
      y: coords[i][1],
      similarity: sim,
      r: 2 + Math.max(0, sim) * 5,
    });
  }
  return stars;
}

/**
 * 按相似度降序。
 * @template {{similarity:number}} T
 * @param {T[]} stars
 * @returns {T[]}
 */
export function rankBySimilarity(stars) {
  return stars.slice().sort((a, b) => b.similarity - a.similarity);
}

/**
 * 星座引线：距离够近且相似度够高的星点对连一条线。
 *
 * 关键：t-SNE 输出的坐标尺度是任意量纲（实测常在 ±20 量级），
 * 用写死的绝对距离阈值去卡，会一条线都连不上。
 * 因此 autoScale 模式按 k-近邻距离的分位数自动定尺度，与量纲无关。
 *
 * @param {{x:number,y:number,similarity:number,label:string}[]} stars
 * @param {{maxDistance?: number, minSimilarity?: number, autoScale?: boolean, k?: number, quantile?: number}} [opts]
 */
export function buildConstellationLinks(stars, opts = {}) {
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const autoScale = opts.autoScale === true && opts.maxDistance === undefined;
  const maxDistance = autoScale
    ? autoLinkDistance(stars, opts.k ?? 3, opts.quantile ?? 0.6)
    : opts.maxDistance ?? 1.2;

  const links = [];
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const a = stars[i];
      const b = stars[j];
      if (Math.min(a.similarity, b.similarity) < minSimilarity) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > maxDistance) continue;
      links.push({ a: a.label, b: b.label, ai: i, bi: j, distance: d });
    }
  }
  return links;
}

/**
 * 从点集的 k-近邻距离分布推出一个连线阈值。
 * 取每点最近 k 个邻居的距离，再取分位数——这样无论坐标是 0.001 还是 500 都成立。
 * @param {{x:number,y:number}[]} stars
 * @param {number} k
 * @param {number} quantile
 * @returns {number}
 */
export function autoLinkDistance(stars, k = 3, quantile = 0.6) {
  const n = stars.length;
  if (n < 2) return 0;
  const nn = [];
  for (let i = 0; i < n; i++) {
    const ds = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      ds.push(Math.hypot(stars[i].x - stars[j].x, stars[i].y - stars[j].y));
    }
    ds.sort((a, b) => a - b);
    const take = Math.min(k, ds.length);
    for (let t = 0; t < take; t++) nn.push(ds[t]);
  }
  if (!nn.length) return 0;
  nn.sort((a, b) => a - b);
  const idx = Math.min(nn.length - 1, Math.max(0, Math.floor(nn.length * quantile)));
  // 兜底：尺度退化（全部重合）时给一个极小正数，避免全连
  return nn[idx] > 0 ? nn[idx] : 1e-6;
}

/**
 * 松弛：把挨太近的星推开一点，免得糊成一团光斑。
 * 原地修改。
 * @param {{x:number,y:number,r?:number}[]} stars
 * @param {{iterations?: number, minGap?: number, strength?: number}} [opts]
 */
export function gravityRelax(stars, opts = {}) {
  const iterations = opts.iterations ?? 24;
  const minGap = opts.minGap ?? 6;
  const strength = opts.strength ?? 0.5;
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const a = stars[i];
        const b = stars[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        const gap = minGap + (a.r ?? 0) + (b.r ?? 0);
        if (d >= gap) continue;
        if (d < 1e-6) {
          // 完全重合：给一个确定方向,别让它悬着
          dx = 0.01 * (i + 1);
          dy = 0.01 * (j + 1);
          d = Math.hypot(dx, dy);
        }
        const push = ((gap - d) / d) * strength * 0.5;
        const ox = dx * push;
        const oy = dy * push;
        a.x -= ox;
        a.y -= oy;
        b.x += ox;
        b.y += oy;
      }
    }
  }
  return stars;
}

/**
 * 把任意二维点集归一化到画布坐标。
 * @param {{x:number,y:number}[]} stars
 * @param {{width:number,height:number,padding?:number}} opts
 */
export function fitToCanvas(stars, opts) {
  const padding = opts.padding ?? 60;
  const width = opts.width;
  const height = opts.height;
  if (!stars.length) return stars;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stars) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const offX = padding + ((width - padding * 2) - spanX * scale) / 2;
  const offY = padding + ((height - padding * 2) - spanY * scale) / 2;
  return stars.map((s) => ({
    ...s,
    x: offX + (s.x - minX) * scale,
    y: offY + (s.y - minY) * scale,
  }));
}
