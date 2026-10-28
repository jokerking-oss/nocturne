/**
 * NOCTURNE 内核测试 — 纯 Node，无浏览器依赖。
 * 覆盖：分块、余弦相似度、星座重心、t-SNE 输入装配、阈值过滤。
 * 运行：node test/kernel.test.js
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  splitText,
  cosineSimilarity,
  meanVector,
  buildTsneInput,
  projectToStars,
  gravityRelax,
  rankBySimilarity,
  buildConstellationLinks,
} from '../src/js/kernel.js';

const eps = 1e-9;

test('splitText 按句号/换行切块并去除空白块', () => {
  const out = splitText('第一句。第二句！\n第三句？  ');
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => s.trim().length > 0));
});

test('splitText 对空输入返回空数组', () => {
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText('   \n\n  '), []);
});

test('cosineSimilarity 同向量为 1，正交为 0，反向为 -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < eps);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < eps);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < eps);
});

test('cosineSimilarity 拒绝零向量而不是抛 NaN', () => {
  const v = cosineSimilarity([0, 0, 0], [1, 2, 3]);
  assert.ok(Number.isFinite(v), '零向量不应产生 NaN');
  assert.equal(v, 0);
});

test('cosineSimilarity 长度不匹配时抛错', () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /length/i);
});

test('meanVector 正确求重心', () => {
  const m = meanVector([[1, 3], [3, 5]]);
  assert.deepEqual(m, [2, 4]);
});

test('meanVector 空输入返回 null', () => {
  assert.equal(meanVector([]), null);
});

test('buildTsneInput 补齐到 t-SNE 最小样本数 61 且可裁剪回原长度', () => {
  const dict = { a: [1, 0, 0], b: [0, 1, 0] };
  const { matrix, originalLength } = buildTsneInput(dict, { minSamples: 61, seed: 7 });
  assert.equal(originalLength, 2);
  assert.equal(matrix.length, 61, '应补齐到 minSamples');
  assert.equal(matrix[0].length, 3, '维度保持');
  assert.deepEqual(matrix[0], [1, 0, 0], '前 N 行是原始向量，未被随机填充覆盖');
});

test('buildTsneInput 在样本足够时不补齐', () => {
  const dict = {};
  for (let i = 0; i < 80; i++) dict['k' + i] = [i, 1, 0];
  const { matrix, originalLength } = buildTsneInput(dict, { minSamples: 61, seed: 1 });
  assert.equal(originalLength, 80);
  assert.equal(matrix.length, 80);
});

test('buildTsneInput 用确定性种子生成填充向量（可复现）', () => {
  const dict = { a: [1, 0] };
  const one = buildTsneInput(dict, { minSamples: 61, seed: 42 }).matrix;
  const two = buildTsneInput(dict, { minSamples: 61, seed: 42 }).matrix;
  assert.deepEqual(one[5], two[5], '同种子应产生相同填充');
  const three = buildTsneInput(dict, { minSamples: 61, seed: 43 }).matrix;
  assert.notDeepEqual(one[5], three[5], '不同种子应产生不同填充');
});

test('projectToStars 输出带 label/similarity 的星点并过滤阈值', () => {
  const coords = [[0, 0], [1, 1], [2, 2]];
  const labels = ['a', 'b', 'c'];
  const sims = [0.9, 0.4, 0.8];
  const stars = projectToStars(coords, labels, sims, { threshold: 0.5 });
  assert.equal(stars.length, 2, '低于阈值的星被过滤');
  assert.equal(stars[0].label, 'a');
  assert.equal(stars[0].similarity, 0.9);
  assert.deepEqual(stars[0].x, 0);
});

test('projectToStars 忽略超出原始长度的补齐坐标', () => {
  const coords = [[0, 0], [1, 1], [9, 9], [9, 9]];
  const stars = projectToStars(coords, ['a', 'b'], [0.9, 0.9], { threshold: 0 });
  assert.equal(stars.length, 2, '不应把 t-SNE 补齐点画成星');
});

test('rankBySimilarity 按相似度降序排列', () => {
  const stars = [
    { label: 'low', similarity: 0.1 },
    { label: 'high', similarity: 0.95 },
    { label: 'mid', similarity: 0.5 },
  ];
  const ranked = rankBySimilarity(stars);
  assert.deepEqual(ranked.map((s) => s.label), ['high', 'mid', 'low']);
});

test('buildConstellationLinks 只连接高于阈值的近邻，且不重复不自环', () => {
  const stars = [
    { label: 'a', x: 0, y: 0, similarity: 0.9 },
    { label: 'b', x: 1, y: 0, similarity: 0.8 },
    { label: 'c', x: 10, y: 10, similarity: 0.2 },
  ];
  const links = buildConstellationLinks(stars, { maxDistance: 2, minSimilarity: 0.5 });
  assert.ok(links.length >= 1, 'a-b 应连线');
  assert.ok(links.every((l) => l.a !== l.b), '不应自环');
  const keys = links.map((l) => [l.a, l.b].sort().join('|'));
  assert.equal(new Set(keys).size, keys.length, '不应重复');
  assert.ok(!links.some((l) => l.a === 'c' || l.b === 'c'), 'c 距离太远且相似度过低');
});

test('gravityRelax 把重叠星点推开', () => {
  const stars = [
    { x: 0, y: 0, r: 4 },
    { x: 0.0001, y: 0, r: 4 },
  ];
  const before = Math.hypot(stars[0].x - stars[1].x, stars[0].y - stars[1].y);
  gravityRelax(stars, { iterations: 30, minGap: 6, strength: 0.5 });
  const after = Math.hypot(stars[0].x - stars[1].x, stars[0].y - stars[1].y);
  assert.ok(after > before, `应被推开: ${before} -> ${after}`);
});

test('gravityRelax 不产生 NaN', () => {
  const stars = [{ x: 0, y: 0, r: 4 }, { x: 0, y: 0, r: 4 }, { x: 1, y: 1, r: 4 }];
  gravityRelax(stars, { iterations: 10, minGap: 6, strength: 0.5 });
  assert.ok(stars.every((s) => Number.isFinite(s.x) && Number.isFinite(s.y)));
});

test('buildConstellationLinks 在 t-SNE 真实尺度（±20）下仍能连线', () => {
  // 真 bug 回归：t-SNE 输出坐标尺度是几十，而 maxDistance 写死 1.4，
  // 结果一条线都连不上，星图看起来是散的。
  const stars = [
    { label: 'a', x: -19.4, y: 1.2, similarity: 0.80 },
    { label: 'b', x: -7.4, y: 4.3, similarity: 0.78 },
    { label: 'c', x: 8.1, y: -13.2, similarity: 0.74 },
    { label: 'd', x: -3.2, y: -17.9, similarity: 0.80 },
  ];
  const links = buildConstellationLinks(stars, { autoScale: true, minSimilarity: 0.5 });
  assert.ok(links.length > 0, `真实尺度下应有连线，实际 ${links.length} 条`);
});

test('buildConstellationLinks 自适应阈值不把全部点连成一团', () => {
  const stars = [];
  for (let i = 0; i < 20; i++) {
    stars.push({ label: 'n' + i, x: Math.cos(i) * 20, y: Math.sin(i) * 20, similarity: 0.9 });
  }
  const links = buildConstellationLinks(stars, { autoScale: true, minSimilarity: 0.5 });
  const maxPossible = (20 * 19) / 2;
  assert.ok(links.length < maxPossible, '不应全连接');
  assert.ok(links.length > 0, '也不应一条都没有');
});

test('buildConstellationLinks 显式 maxDistance 仍然生效（向后兼容）', () => {
  const stars = [
    { label: 'a', x: 0, y: 0, similarity: 0.9 },
    { label: 'b', x: 100, y: 0, similarity: 0.9 },
  ];
  const links = buildConstellationLinks(stars, { maxDistance: 1, minSimilarity: 0.5 });
  assert.equal(links.length, 0, '显式阈值应优先生效');
});
