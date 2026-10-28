/**
 * NOCTURNE — 星图渲染。
 *
 * 一张 Canvas，两遍绘制：先是连线与光晕，然后是星点与字。
 * 半衰拖影让移动留有余温；颗粒层每帧重掷，像老胶片。
 * 所有绘制参数在这里，与外部状态无关。
 */

const TAU = Math.PI * 2;

/**
 * 相似度 -> 颜色。冷到暖：远星是月光白，近星是余烬橙。
 * @param {number} sim -1..1
 * @param {number} alpha
 */
export function emberColor(sim, alpha = 1) {
  const t = Math.max(0, Math.min(1, (sim + 1) / 2));
  // 低：月白 #cfd8e3 → 中：青灰 #6f8f80 → 高：余烬 #f0b070
  let r, g, b;
  if (t < 0.62) {
    const k = t / 0.62;
    r = Math.round(111 + (207 - 111) * (1 - k));
    g = Math.round(143 + (216 - 143) * (1 - k));
    b = Math.round(128 + (227 - 128) * (1 - k));
    // 远处更暗
    const fade = 0.32 + 0.5 * k;
    r = Math.round(r * fade + (207 * (1 - fade)) * 0);
    g = Math.round(g * fade);
    b = Math.round(b * fade);
  } else {
    const k = (t - 0.62) / 0.38;
    r = Math.round(111 + (240 - 111) * k);
    g = Math.round(143 + (176 - 143) * k);
    b = Math.round(128 + (112 - 128) * k);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 星图渲染器。
 */
export class Sky {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.stars = [];
    this.links = [];
    this.view = { x: 0, y: 0, k: 1 };
    this.hover = null;
    this.selected = null;
    this.opts = { links: true, labels: false, grain: true };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.grainSeed = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w;
    this.h = h;
  }

  /**
   * 换一批星星。自动居中。
   * @param {{x:number,y:number,r:number,similarity:number,text:string,label:string}[]} stars
   * @param {{links?: {a:number,b:number}[], fit?: boolean}} [opts]
   */
  setStars(stars, opts = {}) {
    this.stars = stars;
    this.links = opts.links || [];
    if (opts.fit !== false) this.fit();
  }

  /** 把当前星点缩放居中到画布。 */
  fit() {
    if (!this.stars.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.stars) {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x);
      maxY = Math.max(maxY, s.y);
    }
    const pad = Math.min(this.w, this.h) * 0.16;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const k = Math.min((this.w - pad * 2) / spanX, (this.h - pad * 2) / spanY);
    this.view.k = Math.max(0.05, Math.min(k, 40));
    this.view.x = this.w / 2 - ((minX + maxX) / 2) * this.view.k;
    this.view.y = this.h / 2 - ((minY + maxY) / 2) * this.view.k;
  }

  /** 屏幕坐标 -> 世界坐标 */
  toWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k };
  }

  /** 世界坐标 -> 屏幕坐标 */
  toScreen(wx, wy) {
    return { x: wx * this.view.k + this.view.x, y: wy * this.view.k + this.view.y };
  }

  /**
   * 命中测试。返回最近的星，或 null。
   * @param {number} sx
   * @param {number} sy
   * @param {number} [slack] 容差（屏幕像素）
   */
  hit(sx, sy, slack = 11) {
    let best = null;
    let bestD = slack * slack;
    for (const s of this.stars) {
      const p = this.toScreen(s.x, s.y);
      const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  loop() {
    this.draw();
    requestAnimationFrame(this.loop);
  }

  draw() {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 拖影：不清干净，留一点余温
    ctx.fillStyle = 'rgba(7,7,10,0.34)';
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawField();
    if (this.opts.links) this.drawLinks();
    this.drawStars();
    if (this.opts.labels) this.drawLabels();
    if (this.opts.grain) this.drawGrain();
  }

  /** 背景：极慢漂移的经纬线，像老星图的坐标格 */
  drawField() {
    const { ctx } = this;
    const step = 120 * this.view.k;
    if (step < 14) return;
    const offX = this.view.x % step;
    const offY = this.view.y % step;
    ctx.save();
    ctx.strokeStyle = 'rgba(38,38,47,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offX; x < this.w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.h);
    }
    for (let y = offY; y < this.h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawLinks() {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 1;
    for (const l of this.links) {
      const a = this.stars[l.a];
      const b = this.stars[l.b];
      if (!a || !b) continue;
      const pa = this.toScreen(a.x, a.y);
      const pb = this.toScreen(b.x, b.y);
      // 连线亮度取两端较暗的一颗，让疏密自然
      const s = Math.min(a.similarity, b.similarity);
      const alpha = 0.05 + Math.max(0, s) * 0.3;
      ctx.strokeStyle = emberColor(s, alpha);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawStars() {
    const { ctx } = this;
    const t = performance.now() / 1000;
    ctx.save();
    for (const s of this.stars) {
      const p = this.toScreen(s.x, s.y);
      if (p.x < -60 || p.x > this.w + 60 || p.y < -60 || p.y > this.h + 60) continue;

      const base = Math.max(1.1, s.r * Math.min(2.4, Math.max(0.4, this.view.k * 0.9)));
      const isHot = this.hover === s || this.selected === s;
      // 呼吸：离(val的关系让它闪得不齐
      const twinkle = 0.82 + 0.18 * Math.sin(t * 0.9 + s.id * 1.7);
      const alpha = Math.min(1, (0.3 + Math.max(0, s.similarity) * 0.75) * twinkle);

      // 外晕：越相似越亮
      const glow = isHot ? base * 7 : base * (2.4 + Math.max(0, s.similarity) * 3.2);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glow);
      g.addColorStop(0, emberColor(s.similarity, alpha * (isHot ? 0.6 : 0.34)));
      g.addColorStop(0.4, emberColor(s.similarity, alpha * 0.1));
      g.addColorStop(1, emberColor(s.similarity, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, glow, 0, TAU);
      ctx.fill();

      // 核心
      ctx.fillStyle = isHot ? '#fff4e2' : emberColor(s.similarity, Math.min(1, alpha + 0.25));
      ctx.beginPath();
      ctx.arc(p.x, p.y, isHot ? base * 1.5 : base, 0, TAU);
      ctx.fill();

      // 被选中的星：画一圈取景框
      if (this.selected === s) {
        const q = base * 5.5;
        ctx.strokeStyle = 'rgba(240,176,112,0.75)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // 四个角，不是圆——保持器械感
        ctx.moveTo(p.x - q, p.y - q + 5); ctx.lineTo(p.x - q, p.y - q); ctx.lineTo(p.x - q + 5, p.y - q);
        ctx.moveTo(p.x + q - 5, p.y - q); ctx.lineTo(p.x + q, p.y - q); ctx.lineTo(p.x + q, p.y - q + 5);
        ctx.moveTo(p.x + q, p.y + q - 5); ctx.lineTo(p.x + q, p.y + q); ctx.lineTo(p.x + q - 5, p.y + q);
        ctx.moveTo(p.x - q + 5, p.y + q); ctx.lineTo(p.x - q, p.y + q); ctx.lineTo(p.x - q, p.y + q - 5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawLabels() {
    const { ctx } = this;
    ctx.save();
    ctx.font = '10px "SFMono-Regular", Menlo, monospace';
    ctx.fillStyle = 'rgba(169,163,150,0.85)';
    for (const s of this.stars) {
      const p = this.toScreen(s.x, s.y);
      if (p.x < 0 || p.x > this.w || p.y < 0 || p.y > this.h) continue;
      const snippet = s.text.length > 26 ? s.text.slice(0, 26) + '…' : s.text;
      ctx.fillText(snippet, p.x + 8, p.y + 3);
    }
    ctx.restore();
  }

  /** 颗粒层：每帧重掷的稀疏噪点 */
  drawGrain() {
    const { ctx } = this;
    const n = 320;
    ctx.save();
    ctx.fillStyle = 'rgba(232,226,212,0.05)';
    // 确定性 PRNG，避免依赖 Math.random 造成的闪动不均
    this.grainSeed = (this.grainSeed + 1) >>> 0;
    let h = this.grainSeed * 2654435761;
    for (let i = 0; i < n; i++) {
      h ^= h << 13; h >>>= 0;
      h ^= h >> 17;
      h ^= h << 5; h >>>= 0;
      const x = (h % this.w);
      const y = ((h >>> 8) % this.h);
      ctx.fillRect(x, y, 1, 1);
    }
    ctx.restore();
  }
}
