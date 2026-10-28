/**
 * NOCTURNE 构建契约测试。
 *
 * 起因：worker chunk 里的 importScripts() 相对 worker 自身位置解析。
 * publicPath 一旦写成相对路径（'' 或 './'），它会拼成
 * /assets/assets/<chunk>.js，直接 404 —— 模型永远装不上，页面卡在 Standby。
 * 这类 bug 单测抓不到、浏览器里才现形，所以在这里把它钉死。
 *
 * 运行：node test/build.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cfgSrc = readFileSync(path.join(root, 'webpack.config.js'), 'utf8');

test('webpack publicPath 必须是绝对根路径（worker importScripts 回归防线）', () => {
  const m = cfgSrc.match(/publicPath:\s*['"]([^'"]*)['"]/);
  assert.ok(m, 'webpack.config.js 未显式声明 publicPath');
  assert.equal(m[1], '/', `publicPath 必须是 '/'，实测为 '${m[1]}'`);
});

test('webpack 开启 asyncWebAssembly（wasm-bhtsne 需要它）', () => {
  assert.match(cfgSrc, /asyncWebAssembly:\s*true/, '缺 asyncWebAssembly');
});

test('webpack 为 .wasm/.onnx 配置了 asset/resource', () => {
  // 源码里写的是 test: /\.(wasm|onnx)$/i —— 直接查字面子串
  assert.ok(cfgSrc.includes('(wasm|onnx)'), '未处理 wasm/onnx 资源');
  assert.ok(cfgSrc.includes('asset/resource'), '应为 asset/resource');
});

test('dist 产物存在关键文件', () => {
  const distDir = path.join(root, 'dist');
  let ok = true;
  try {
    readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    ok = false;
  }
  // dist 可能未构建（纯 Node CI）；缺 dist 时只提示，不判失败
  if (!ok) {
    assert.ok(true, 'dist 未构建，跳过产物检查');
    return;
  }
  const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
  // 压缩器会剥掉属性引号，所以断言用宽松形式
  assert.match(html, /<canvas id=["']?sky["']?\s*\/?>/, 'index.html 应包含画布 #sky');
  assert.match(html, /NOCTURNE/, 'index.html 应包含作品名');
});

test('dist 产物里 worker chunk 路径不以 assets/assets 开头', () => {
  const distAssets = path.join(root, 'dist', 'assets');
  let files = [];
  try {
    files = readdirSync(distAssets);
  } catch {
    // 未构建则跳过
    assert.ok(true, 'dist 未构建，跳过 worker 路径检查');
    return;
  }
  // importScripts 的调用不应出现 /assets/assets/
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(path.join(distAssets, f), 'utf8');
    assert.doesNotMatch(
      src,
      /assets\/assets\//,
      `${f} 内含 /assets/assets/ —— publicPath 又配错了`
    );
  }
});
