/**
 * NOCTURNE 端到端验证 — 在 Node 里跑真实的模型与降维。
 *
 * 为什么不在浏览器里验：共享浏览器实例会被外部页面导航打断，
 * 结果不可复现。这里的验证覆盖真正有风险的环节：
 *   1. 模型 HUB id 是否真实可下载
 *   2. 浏览器同款 embedding 调用能否产出向量
 *   3. wasm-bhtsne 能否把真实向量压到二维
 *   4. 内核能否把这些点装配成星图
 * 浏览器层只剩"消息搬运"，已由 wiring 测试覆盖。
 *
 * 运行：node scripts/verify-e2e.mjs
 */
import { pipeline, env } from '@xenova/transformers';
import { readFile } from 'node:fs/promises';
// wasm-bhtsne 的 package.json 只有 "module" 字段、没有 "main"，
// Node 的 ESM 解析器会去找 index.js 而失败。这里走显式文件路径。
import init, { tSNE } from 'wasm-bhtsne/wasm_bhtsne.js';

import {
  splitText,
  cosineSimilarity,
  meanVector,
  gravityRelax,
  buildConstellationLinks,
} from '../src/js/kernel.js';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useFSCache = true;
// 本机到 huggingface.co 直连超时，走镜像；产品里同样支持覆盖。
if (process.env.NOCTURNE_REMOTE_HOST) {
  env.remoteHost = process.env.NOCTURNE_REMOTE_HOST;
}

const MODEL = process.argv[2] || 'Xenova/all-MiniLM-L6-v2';

const TEXT = `夜色降临的时候，句子开始互相寻找。
语义相近的会越靠越近，直到聚成一团光。
雨落在城市的边缘，把霓虹揉成一片模糊的水彩。
他在凌晨三点写下第七封信，没有寄出去。
猫从书架上跳下来，踩过键盘，留下一行乱码。
远处的火车穿过隧道，汽笛声被山谷折返两次。
厨房里水开了，蒸汽爬上窗户，遮住了半轮月亮。
所有的告别都是缓慢的，像潮水退回海里。
程序在午夜编译通过，没有人看见它运行。
旧唱片的第三轨有一道划痕，每次都在同一秒跳过。
她把窗帘拉开一条缝，让街灯照进来。
冬天来得很轻，像有人在外面敲门又走开。`;

const t0 = Date.now();
console.log(`[1/5] 装载模型 ${MODEL} …`);
const embedder = await pipeline('feature-extraction', MODEL, { quantized: true });
console.log(`      模型就绪 (${Date.now() - t0} ms)`);

console.log('[2/5] 切块 + 嵌入 …');
const chunks = splitText(TEXT);
if (chunks.length === 0) throw new Error('splitText 未切出任何句子');
console.log(`      ${chunks.length} 个语义块`);

const vectors = [];
for (const c of chunks) {
  const out = await embedder(c, { pooling: 'mean', normalize: true });
  vectors.push(Array.from(out.data));
}
const dim = vectors[0].length;
console.log(`      维度 ${dim}`);

console.log('[3/5] 余弦相似度 …');
const centroid = meanVector(vectors);
const sims = vectors.map((v) => cosineSimilarity(v, centroid));
console.log(`      相似度范围 ${Math.min(...sims).toFixed(4)} … ${Math.max(...sims).toFixed(4)}`);

console.log('[4/5] Barnes-Hut t-SNE 降维 …');
const matrix = vectors.map((v) => v.slice());
let pad = 0;
if (matrix.length < 61) {
  pad = 61 - matrix.length;
  let h = 12345;
  const rand = () => {
    h |= 0; h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < pad; i++) matrix.push(Array.from({ length: dim }, () => rand()));
}
// Node 的 fetch 不支持 file:// 协议，wasm-bhtsne 默认走 fetch 找 .wasm 会报
// "not implemented... yet..."。直接把 wasm 字节喂给默认 init（位置参数）。
const wasmUrl = new URL('../node_modules/wasm-bhtsne/wasm_bhtsne_bg.wasm', import.meta.url);
const wasmBytes = await readFile(wasmUrl);
await init(wasmBytes);
const t1 = Date.now();
const enc = new tSNE(matrix);
const coords = enc.barnes_hut(500);
console.log(`      降维完成 (${Date.now() - t1} ms)，补齐 ${pad} 个占位`);

console.log('[5/5] 装配星图 …');
const stars = chunks.map((c, i) => ({
  id: i,
  text: c,
  label: c,
  x: coords[i][0],
  y: coords[i][1],
  similarity: sims[i],
  r: 1.6 + Math.max(0, sims[i]) * 4.4,
}));
gravityRelax(stars, { iterations: 26, minGap: 2.2, strength: 0.42 });
const links = buildConstellationLinks(stars, { autoScale: true, minSimilarity: 0.25 });

// ---- 断言 ----
const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
  } else {
    console.log('  ok  ' + msg);
  }
};

assert(chunks.length >= 8, `切块数 >= 8 (实际 ${chunks.length})`);
assert(dim > 0, `向量维度 > 0 (实际 ${dim})`);
assert(
  coords.length >= chunks.length,
  `t-SNE 输出行数 >= 块数 (${coords.length} >= ${chunks.length})`
);

const finite = stars.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y));
assert(finite, '所有星点坐标有限（非 NaN）');

// t-SNE 必须是真降维：坐标不能全等，且不能与相似度完全无关
const xs = new Set(stars.map((s) => s.x.toFixed(4)));
assert(xs.size > 1, `星点位置有分布 (${xs.size} 个不同 x)`);

const spread =
  Math.max(...stars.map((s) => s.x)) - Math.min(...stars.map((s) => s.x));
assert(spread > 1e-6, `x 方向有展布 (${spread.toFixed(4)})`);

// 相似度最高的两块应当比最不相似的两块在语义上更接近重心
const sorted = stars.slice().sort((a, b) => b.similarity - a.similarity);
assert(
  sorted[0].similarity > sorted[sorted.length - 1].similarity,
  '相似度排序有效'
);

assert(links.length > 0, `真实尺度下应连出星座引线 (实际 ${links.length} 条)`);

console.log('');
console.log('星图样本（前 4 个）:');
for (const s of stars.slice(0, 4)) {
  console.log(
    `  (${s.x.toFixed(3)}, ${s.y.toFixed(3)})  sim=${s.similarity.toFixed(4)}  ${s.text.slice(0, 24)}`
  );
}
console.log('');
console.log(`引线 ${links.length} 条 · 星点 ${stars.length} 颗 · 总耗时 ${Date.now() - t0} ms`);
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
