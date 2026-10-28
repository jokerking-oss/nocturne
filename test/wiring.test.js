/**
 * NOCTURNE 接线测试 — 保证入口 index.js 真的把 UI 接到 Worker 与 Sky 上。
 *
 * 起因：曾经 worker 从未被实例化，页面永久停在 "Standby"，
 * 而内核测试全绿 —— 单测覆盖不到"有没有接上"。这两个用例补的就是这一层。
 *
 * 运行：node test/wiring.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const indexSrc = readFileSync(path.join(root, 'src/js/index.js'), 'utf8');
const workerSrc = readFileSync(path.join(root, 'src/js/worker.js'), 'utf8');
const htmlSrc = readFileSync(path.join(root, 'index.html'), 'utf8');

test('index.js 必须实例化 Worker（否则页面永久停在 Standby）', () => {
  assert.match(indexSrc, /new Worker\(/, '入口应 new Worker');
});

test('Worker 必须是 classic 而非 module —— ONNX Runtime 的 importScripts 回归防线', () => {
  // 曾以 { type: 'module' } 创建 worker，结果 ORT 内部调用 importScripts()
  // 触发 "Module scripts don't support importScripts()"，模型永远装不上。
  assert.doesNotMatch(
    indexSrc,
    /new Worker\([^)]*type:\s*['"]module['"]/,
    '不要用 { type: "module" } —— ORT 依赖 importScripts()'
  );
});

test('index.js 必须绑定 worker 消息与错误监听', () => {
  assert.match(indexSrc, /worker\.addEventListener\(['"]message['"]/, '缺 message 监听');
  assert.match(indexSrc, /worker\.addEventListener\(['"]error['"]/, '缺 error 监听，故障会静默');
});

test('waiters 分派不覆盖主 handler（分号)^{\\s*waiters/ 回归防线）', () => {
  assert.match(indexSrc, /waiters/, '应使用 waiters 等待表');
  // 旧的坏实现会临时替换 worker.onmessage，必须不再出现
  assert.doesNotMatch(
    indexSrc,
    /const\s+prev\s*=\s*worker\.onmessage/,
    '不得临时替换 worker.onmessage —— 那会吞掉并发消息'
  );
});

test('index.js 启动时自动装载引擎（不需要用户先点按钮）', () => {
  assert.match(indexSrc, /postMessage\(\{\s*type:\s*['"]load['"]/, '应在开场即 postMessage load');
});

test('装载不能早于 worker.onmessage 绑定 —— Standby 死锁回归防线', () => {
  // 曾经 load 写在模块末尾、排在 worker.onmessage 赋值之前，
  // postMessage 先发出而 handler 后挂，worker 的 ready 回包无人接收。
  const msgIdx = indexSrc.indexOf('worker.onmessage');
  const bootIdx = indexSrc.lastIndexOf('bootEngine()');
  assert.ok(msgIdx > 0, '应有 worker.onmessage');
  assert.ok(bootIdx > 0, '应调用 bootEngine()');
  assert.ok(bootIdx > msgIdx, 'bootEngine() 必须在 worker.onmessage 绑定之后');

  // 也不能用 rAF / setTimeout 延后：后台标签页里 rAF 不触发、定时器被
  // 节流到每分钟一次，引擎就永远停在 Standby。
  assert.doesNotMatch(
    indexSrc,
    /requestAnimationFrame\([^)]*bootEngine/,
    '不得用 requestAnimationFrame 延后装载'
  );
  assert.doesNotMatch(
    indexSrc,
    /setTimeout\(\s*bootEngine/,
    '不得用 setTimeout 延后装载'
  );
});

test('worker 支持全链路消息：load / embedBatch / query / setQuery / tsne / meanEmbedding', () => {
  for (const t of ['load', 'embedBatch', 'query', 'setQuery', 'tsne', 'meanEmbedding']) {
    assert.match(workerSrc, new RegExp(`case\\s+['"]${t}['"]`), `worker 缺少 case '${t}'`);
  }
});

test('worker 模型加载用本地优先 + 远端兜底的三级策略', () => {
  assert.match(workerSrc, /LOCAL_PREFIX/, '应有本地前缀');
  assert.match(workerSrc, /env\.allowLocalModels/, '应可切换本地/远端');
  assert.match(workerSrc, /env\.allowRemoteModels/, '应可切换远端开关');
  assert.match(workerSrc, /env\.remoteHost/, '必须显式设置 remoteHost');
  // 本地源必须排在远端源之前
  const localIdx = workerSrc.indexOf('local: true');
  const remoteIdx = workerSrc.indexOf('local: false');
  assert.ok(localIdx > 0 && remoteIdx > localIdx, '本地源应排在远端源之前');
});

test('worker 在首个模型源不可达时自动切下一个（优雅降级）', () => {
  assert.match(workerSrc, /MODEL_HOSTS/, '应有模型源列表');
  assert.match(workerSrc, /hf-mirror\.com/, '应包含镜像源');
  assert.match(workerSrc, /sourceRetry/, '切换源时应回报 sourceRetry');
  assert.match(indexSrc, /case\s+['"]sourceRetry['"]/, 'index.js 应处理 sourceRetry');
  assert.match(indexSrc, /case\s+['"]source['"]/, 'index.js 应处理 source');
});

test('worker 在 embedded 后自动请求重心 meanEmbedding', () => {
  assert.match(workerSrc, /type:\s*['"]embedded['"]/, 'worker 应回报 embedded');
  assert.match(workerSrc, /type:\s*['"]meanEmbedding['"]/, 'worker 应回报 meanEmbedding');
});

test('index.js 无种子时用全文重心当引力源，有种子时直接用种子', () => {
  assert.match(indexSrc, /state\.lastQuery/, '应区分有/无种子');
  assert.match(indexSrc, /type:\s*['"]setQuery['"]/, '应发送 setQuery');
});

test('observe() 显式驱动全链路，避免 handler 与流程双重串联', () => {
  // 曾经 'embedded' handler 与 observe() 各发一次 t-SNE，导致重复渲染。
  // 现在的契约：embedded 分支只 break，后续由 observe 显式驱动。
  const embeddedCase = indexSrc.match(/case\s+['"]embedded['"]\s*:\s*\{[\s\S]{0,300}?\}/);
  assert.ok(embeddedCase, '应有 embedded 分支');
  assert.doesNotMatch(
    embeddedCase[0],
    /runTsne\(|meanEmbedding'\s*\}/,
    'embedded 分支不得再串联后续阶段'
  );
  // observe 必须依次走：embedBatch -> meanEmbedding -> query/setQuery -> runTsne
  assert.match(indexSrc, /await once\(['"]embedded['"]/);
  assert.match(indexSrc, /await once\(['"]meanEmbedding['"]\)/);
  assert.match(indexSrc, /runTsne\(\);\s*\}/, 'observe 结尾应调用 runTsne');
});

test('诊断钩子存在：worker 错误不冒泡到 window.onerror', () => {
  assert.match(indexSrc, /window\.__nocturne/, '应暴露 __nocturne 诊断对象');
  assert.match(indexSrc, /trace/, '应记录收发轨迹');
});

test('once() 不带 payload 时只注册等待者，不发送消息', () => {
  // 回归：await once('query') 曾以 postMessage(undefined) 发出，
  // 包装器读 t.type 直接抛 TypeError，流程断在 setQuery 之后。
  assert.match(indexSrc, /payload === undefined/, 'once 应区分"只等"与"发完再等"');
  assert.match(indexSrc, /function waitFor/, '应有独立的 waitFor');
});

test('$ 是 getElementById 别名，不得传 CSS 选择器', () => {
  // 回归：$('.panel[data-panel="text"]').classList.add(...) 返回 null，
  // 模块在装配阶段抛错，后面的 bootEngine() 永不执行，页面死在 Standby。
  const bad = [...indexSrc.matchAll(/\$\(\s*['"]([.#\[][^'"]*)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(bad, [], `$() 被传入选择器: ${bad.join(', ')}`);
});

test('每个 $() 引用的 id 都必须真实存在于 HTML', () => {
  const ids = new Set([...indexSrc.matchAll(/\$\(['"]([\w-]+)['"]\)/g)].map((m) => m[1]));
  const domIds = new Set([...htmlSrc.matchAll(/id=["']([\w-]+)["']/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !domIds.has(id));
  assert.deepEqual(missing, [], `index.js 引用了 HTML 中不存在的 id: ${missing.join(', ')}`);
});

test('Sky 必须提供 index.js 调用的接口', () => {
  const skySrc = readFileSync(path.join(root, 'src/js/sky.js'), 'utf8');
  for (const m of ['setStars', 'fit', 'hit', 'toWorld', 'toScreen']) {
    assert.match(skySrc, new RegExp(`${m}\\s*\\(`), `Sky 缺少方法 ${m}`);
  }
  assert.match(skySrc, /this\.view\s*=\s*\{[^}]*k:/, 'Sky 需要带缩放系数 k 的 view');
});

test('package.json 依赖与源码 import 保持一致', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const all = indexSrc + workerSrc;
  for (const dep of ['@xenova/transformers', 'wasm-bhtsne']) {
    if (all.includes(dep)) {
      assert.ok(pkg.dependencies[dep], `${dep} 被引用但不在 dependencies`);
    }
  }
});

test('CSS 定义了 sky 画布为全屏固定层', () => {
  const css = readFileSync(path.join(root, 'src/css/styles.css'), 'utf8');
  assert.match(css, /#sky\s*\{[^}]*position:\s*fixed/, '#sky 应 fixed 铺满');
  assert.match(css, /#sky\s*\{[^}]*inset:\s*0/, '#sky 应 inset:0');
});

test('worker 监听必须用 addEventListener，不能用 onmessage/onerror 赋值', () => {
  // 回归：本文件曾对 worker.onmessage 赋两次值，后一次覆盖前一次，
  // 消息只走一条路，诊断钩子收不到、幕布也不会变。
  assert.doesNotMatch(
    indexSrc,
    /worker\.onmessage\s*=/,
    '不得用 worker.onmessage 赋值（会互相覆盖）'
  );
  assert.doesNotMatch(
    indexSrc,
    /worker\.onerror\s*=/,
    '不得用 worker.onerror 赋值'
  );
  assert.match(indexSrc, /worker\.addEventListener\(['"]message['"]/, '应用 addEventListener 收消息');
  assert.match(indexSrc, /worker\.addEventListener\(['"]error['"]/, '应用 addEventListener 收错误');
});

test('index.js 必须处理 worker 的 error 消息（否则失败静默停在 Standby）', () => {
  // 回归：worker 早已捕获异常并 postMessage({type:'error'})，
  // 但 index.js 没有对应分支，模型源全挂时页面安静地死在 Standby。
  assert.match(indexSrc, /case\s+['"]error['"]/, 'index.js 应有 case error');
  assert.match(indexSrc, /error:\s*true/, 'error 分支应把幕布切到错误态');
});

test('HTML 里的模型 id 必须是 transformers.js 真实可下载的 HUB id', () => {
  // 回归：曾用 Supabase/gte-small、TaylorAI/gte-tiny、Thennal/bert-base-uncased，
  // 这些在 transformers.js v2 上没有 ONNX 权重，两个源都 404。
  const opts = [...htmlSrc.matchAll(/<option\s+value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(opts.length > 0, '应有模型选项');
  for (const id of opts) {
    assert.ok(id.startsWith('Xenova/'), `模型 id "${id}" 不是 Xenova/ 前缀，v2 上拉不到`);
    assert.match(id, /^Xenova\/[A-Za-z0-9._-]+$/, `模型 id "${id}" 格式不合法`);
  }
});

test('default model 必须是已验证可下载的那个', () => {
  const selected = htmlSrc.match(/<option\s+value="([^"]+)"\s+selected/);
  assert.ok(selected, '应有一个默认选中的模型');
  assert.equal(selected[1], 'Xenova/all-MiniLM-L6-v2', '默认应用端到端验证过的 MiniLM');
});
