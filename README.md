# NOCTURNE — 夜曲

> 一段文本是一群星。语义相近的句子会互相靠近。
> 输入一段话，看着它在浏览器里坍缩成星图。
> 全部计算在你的机器上完成。没有服务器，没有 API Key，没有一次上传。

**[→ 在线体验](https://jokerking-oss.github.io/nocturne/)**

---

## 它是什么

NOCTURNE 把任意文本放进一个本地运行的嵌入模型（WASM/ONNX，浏览器内推理），
得到每句话的高维向量，再用 **Barnes-Hut t-SNE** 压到二维，
画成一张可以缩放、可以点亮、可以悬停倾听的星图。

语义距离被翻译成物理距离。你不需要读懂坐标轴——你只需要看星星怎么聚拢。

## 为什么它是一件作品，不是一个工具

工具回答问题。作品提出问题。

这里的文本不是被"检索"的，是被**供奉**的。每一次查询都在生成一张不同的、
不可复现的天文图景：输入是种子，语义是引力，屏幕上的结果是那一次的宇宙。

视觉上它拒绝 SaaS 语法——没有圆角按钮，没有阴影抬升，没有紫蓝渐变。
取而代之的是枯墨底色、衬线标题、半栏式布局、Canvas 上的颗粒噪声。
它是安静的，硬的，有点旧。

## 技术结构

```
文本 → 分块 → 嵌入模型(浏览器内 ONNX) → 384/768 维向量
     → 均值向量(星座重心) → Barnes-Hut t-SNE → 2D 坐标
     → Canvas 绘制：引力布局 / 相似度着色 / 颗粒层
```

数据流单向、无状态、全部在客户端。刷新即消失——这是设计，不是缺陷。

| 层 | 实现 |
|---|---|
| 推理 | `@xenova/transformers` v2 — 浏览器内 Transformer 推理（WASM + ONNX Runtime） |
| 降维 | `wasm-bhtsne` — Rust 编译到 WASM 的 Barnes-Hut t-SNE |
| 压缩 | `pako` — 星座导出 gzip |
| 绘制 | 原生 Canvas 2D，自绘布局、力导向微调、颗粒噪声层 |
| 构建 | Webpack 5，Worker 隔离推理线程 |

主 UI 线程永不阻塞：模型加载、嵌入、聚类全部跑在 Worker 里。

## 跑起来

```bash
git clone https://github.com/jokerking-oss/nocturne.git
cd nocturne
npm install
npm start          # http://localhost:8080
```

首次打开会把嵌入模型载入内存（体积见下表），权重随站点发布时**完全离线可用**，
不联网也能跑；站点没带权重时会依次尝试 huggingface.co 与镜像站。

构建静态产物：

```bash
npm run build      # 输出到 dist/
npm test           # Node 测试：内核 / 接线 / 构建契约
```

## 面板

- **Text** — 放文本。可以拖入 `.txt` / `.md`，或直接粘贴。
- **Engine** — 换嵌入模型：

  | 模型 | 体积 | 维度 | 适用 |
  |---|---|---|---|
  | `all-MiniLM-L6-v2` | 23 MB | 384 | 默认，英文/中英混排都快 |
  | `gte-tiny` | 25 MB | 384 | 体量小，冷启动最快 |
  | `bge-small-zh-v1.5` | 45 MB | 512 | 纯中文场景更准 |
  | `paraphrase-multilingual-MiniLM-L12-v2` | 118 MB | 384 | 多语种 |

- **Constellation** — 相似度阈值：高于阈值的星才会亮、才会被引线连起来。
- **Lore** — 运行刻度：模型 HUB id、向量维度、切块数、引线数、降维耗时。

## 键盘

| 键 | 作用 |
|---|---|
| `Esc` | 关闭所有面板，回到只有星空的状态 |
| `Space` | 重新布局（换一次随机种子） |
| `Click` 星点 | 点亮它，读出原文 |
| 拖拽 / 滚轮 | 平移 / 缩放星图 |

## 许可

MIT。
