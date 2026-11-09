// Shared renderer + connection for the phone and the TV.
// The picture is a display list of objects; coordinates are normalized 0..1 in the wall's box,
// widths/sizes are fractions of the box width.
//   stroke {id,type:'stroke',mode:'pen'|'marker'|'eraser',c,w,pts:[[x,y],..]}
//   shape  {id,type:'shape',kind:'line'|'arrow'|'rect'|'ellipse',c,w,fill,x1,y1,x2,y2}
//   fill   {id,type:'fill',c,x,y}
//   text   {id,type:'text',c,s,x,y,text}
//   image  {id,type:'image',src,x,y,w,h}
const WP = (() => {
  const BG = '#000000';
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  function hexRgb(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function strokePath(g, pts, W, H) {
    g.beginPath();
    const n = pts.length;
    g.moveTo(pts[0][0] * W, pts[0][1] * H);
    if (n === 1) { g.lineTo(pts[0][0] * W + 0.01, pts[0][1] * H); return; }
    for (let i = 1; i < n - 1; i++) {
      const m = mid(pts[i], pts[i + 1]);
      g.quadraticCurveTo(pts[i][0] * W, pts[i][1] * H, m[0] * W, m[1] * H);
    }
    g.lineTo(pts[n - 1][0] * W, pts[n - 1][1] * H);
  }

  function floodFill(g, sx, sy, color) {
    const W = g.canvas.width, H = g.canvas.height;
    sx = Math.floor(sx); sy = Math.floor(sy);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const img = g.getImageData(0, 0, W, H), d = img.data;
    const k0 = (sy * W + sx) * 4, tr = d[k0], tg = d[k0 + 1], tb = d[k0 + 2];
    const [fr, fg, fb] = hexRgb(color);
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 6) return;
    const TOL = 110;
    const mask = new Uint8Array(W * H);
    const ok = p => { const k = p * 4; return !mask[p] && Math.abs(d[k] - tr) + Math.abs(d[k + 1] - tg) + Math.abs(d[k + 2] - tb) <= TOL; };
    const stack = [sx, sy];
    while (stack.length) {
      const y = stack.pop(), x0 = stack.pop();
      let x = x0, row = y * W;
      while (x >= 0 && ok(row + x)) x--;
      x++;
      let up = false, down = false;
      for (; x < W && ok(row + x); x++) {
        mask[row + x] = 1;
        if (y > 0) { const u = ok(row - W + x); if (u && !up) { stack.push(x, y - 1); up = true; } else if (!u) up = false; }
        if (y < H - 1) { const v = ok(row + W + x); if (v && !down) { stack.push(x, y + 1); down = true; } else if (!v) down = false; }
      }
    }
    // paint filled pixels plus a 1px rim so anti-aliased edges don't leave a halo
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (mask[p] || (x > 0 && mask[p - 1] === 1) || (x < W - 1 && mask[p + 1] === 1) ||
          (y > 0 && mask[p - W] === 1) || (y < H - 1 && mask[p + W] === 1)) {
        const k = p * 4; d[k] = fr; d[k + 1] = fg; d[k + 2] = fb; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  function arrowHead(g, x1, y1, x2, y2, lw) {
    const a = Math.atan2(y2 - y1, x2 - x1), len = Math.max(lw * 3.2, 14);
    g.beginPath();
    g.moveTo(x2 - len * Math.cos(a - 0.45), y2 - len * Math.sin(a - 0.45));
    g.lineTo(x2, y2);
    g.lineTo(x2 - len * Math.cos(a + 0.45), y2 - len * Math.sin(a + 0.45));
    g.stroke();
  }

  class Board {
    constructor(base, live, laser) {
      this.base = base; this.live = live; this.laserC = laser;
      this.bg = base.getContext('2d', { willReadFrequently: true });
      this.lg = live.getContext('2d');
      this.zg = laser.getContext('2d');
      this.objs = []; this.byId = new Map(); this.active = new Set();
      this.imgs = new Map(); this.trails = new Map();
      this.liveQueued = false; this.laserRunning = false; this.redrawQueued = false;
      this.onChange = null;
    }
    get W() { return this.base.width; }
    get H() { return this.base.height; }

    resize(w, h) {
      for (const c of [this.base, this.live, this.laserC]) { c.width = w; c.height = h; }
      this.redraw();
    }

    drawObj(g, o) {
      const W = this.W, H = this.H;
      g.save();
      if (o.type === 'stroke') {
        if (!o.pts || !o.pts.length) { g.restore(); return; }
        g.globalAlpha = o.mode === 'marker' ? 0.42 : 1;
        g.strokeStyle = o.mode === 'eraser' ? BG : o.c;
        g.lineWidth = Math.max(1, o.w * W);
        g.lineCap = 'round'; g.lineJoin = 'round';
        strokePath(g, o.pts, W, H);
        g.stroke();
      } else if (o.type === 'shape') {
        const x1 = o.x1 * W, y1 = o.y1 * H, x2 = o.x2 * W, y2 = o.y2 * H, lw = Math.max(1, o.w * W);
        g.strokeStyle = o.c; g.fillStyle = o.c; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
        if (o.kind === 'line' || o.kind === 'arrow') {
          g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
          if (o.kind === 'arrow') arrowHead(g, x1, y1, x2, y2, lw);
        } else if (o.kind === 'rect') {
          const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
          if (o.fill) g.fillRect(x, y, w, h); else g.strokeRect(x, y, w, h);
        } else if (o.kind === 'ellipse') {
          g.beginPath();
          g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
          if (o.fill) g.fill(); else g.stroke();
        }
      } else if (o.type === 'fill') {
        g.restore();
        floodFill(g, o.x * W, o.y * H, o.c);
        return;
      } else if (o.type === 'text') {
        const px = Math.max(8, o.s * W);
        g.fillStyle = o.c; g.textBaseline = 'top';
        g.font = '600 ' + px + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
        String(o.text || '').split('\n').forEach((line, i) => g.fillText(line, o.x * W, o.y * H + i * px * 1.2));
      } else if (o.type === 'image') {
        const im = this.imgs.get(o.id);
        if (im && im.complete && im.naturalWidth) g.drawImage(im, o.x * W, o.y * H, o.w * W, o.h * H);
      }
      g.restore();
    }

    loadImage(o) {
      if (o.type !== 'image' || this.imgs.has(o.id)) return;
      const im = new Image();
      im.onload = () => this.queueRedraw();
      im.src = o.src;
      this.imgs.set(o.id, im);
    }

    queueRedraw() {
      if (this.redrawQueued) return;
      this.redrawQueued = true;
      requestAnimationFrame(() => { this.redrawQueued = false; this.redraw(); });
    }

    redraw() {
      const g = this.bg;
      g.fillStyle = BG; g.fillRect(0, 0, this.W, this.H);
      for (const o of this.objs) if (!this.active.has(o.id)) this.drawObj(g, o);
      this.drawLive();
      this.onChange && this.onChange();
    }

    drawLive() {
      this.lg.clearRect(0, 0, this.W, this.H);
      for (const o of this.objs) if (this.active.has(o.id)) this.drawObj(this.lg, o);
    }
    queueLive() {
      if (this.liveQueued) return;
      this.liveQueued = true;
      requestAnimationFrame(() => { this.liveQueued = false; this.drawLive(); });
    }

    // committed=true draws straight onto the base layer (fill, text, redo, state)
    add(o, committed) {
      if (this.byId.has(o.id)) return;
      if (o.type === 'stroke' && !o.pts) o.pts = [];
      this.objs.push(o); this.byId.set(o.id, o);
      this.loadImage(o);
      if (committed || o.type === 'fill' || o.type === 'text') { this.drawObj(this.bg, o); this.onChange && this.onChange(); }
      else { this.active.add(o.id); this.queueLive(); }
    }
    pts(id, pts) {
      const o = this.byId.get(id); if (!o || !pts || !pts.length) return;
      for (const p of pts) o.pts.push(p);
      this.queueLive();
    }
    upd(id, props) {
      const o = this.byId.get(id); if (!o) return;
      Object.assign(o, props);
      if (this.active.has(id)) this.queueLive(); else this.queueRedraw();
    }
    end(id) {
      const o = this.byId.get(id); if (!o || !this.active.has(id)) return;
      this.active.delete(id);
      const last = this.objs[this.objs.length - 1] === o;
      if (last) { this.drawObj(this.bg, o); this.drawLive(); this.onChange && this.onChange(); }
      else this.redraw();
    }
    del(id) {
      const o = this.byId.get(id); if (!o) return;
      this.objs.splice(this.objs.indexOf(o), 1);
      this.byId.delete(id); this.active.delete(id); this.imgs.delete(id);
      this.redraw();
    }
    reset(list) {
      this.objs = list || []; this.byId = new Map(); this.active = new Set(); this.imgs = new Map();
      for (const o of this.objs) { this.byId.set(o.id, o); this.loadImage(o); }
      this.redraw();
    }

    // laser pointer: glowing trail that fades out, never saved
    laser(id, pts, color) {
      let t = this.trails.get(id);
      if (!t) { t = { c: color || '#ff3030', pts: [] }; this.trails.set(id, t); }
      const now = performance.now();
      for (const p of pts) t.pts.push([p[0], p[1], now]);
      if (!this.laserRunning) { this.laserRunning = true; requestAnimationFrame(() => this.animLaser()); }
    }
    animLaser() {
      const g = this.zg, W = this.W, H = this.H, now = performance.now(), LIFE = 900;
      g.clearRect(0, 0, W, H);
      let any = false;
      for (const [id, t] of this.trails) {
        while (t.pts.length && now - t.pts[0][2] > LIFE) t.pts.shift();
        if (!t.pts.length) { this.trails.delete(id); continue; }
        any = true;
        const lw = Math.max(3, W * 0.006);
        g.lineCap = 'butt'; g.lineJoin = 'round';
        g.shadowColor = t.c; g.shadowBlur = lw * 3;
        for (let i = 1; i < t.pts.length; i++) {
          const a = t.pts[i - 1], b = t.pts[i], k = 1 - (now - b[2]) / LIFE;
          g.globalAlpha = Math.max(0, k);
          g.strokeStyle = t.c; g.lineWidth = lw * (0.4 + 0.6 * k);
          g.beginPath(); g.moveTo(a[0] * W, a[1] * H); g.lineTo(b[0] * W, b[1] * H); g.stroke();
        }
        const p = t.pts[t.pts.length - 1];
        g.globalAlpha = 1; g.fillStyle = '#fff';
        g.beginPath(); g.arc(p[0] * W, p[1] * H, lw * 0.7, 0, Math.PI * 2); g.fill();
        g.shadowBlur = 0;
      }
      g.globalAlpha = 1;
      if (any) requestAnimationFrame(() => this.animLaser()); else this.laserRunning = false;
    }

    handle(m) {
      switch (m.t) {
        case 'state': this.reset(m.objs); break;
        case 'add': this.add(m.obj); break;
        case 'pts': this.pts(m.id, m.pts); break;
        case 'upd': this.upd(m.id, m.props); break;
        case 'end': this.end(m.id); break;
        case 'del': this.del(m.id); break;
        case 'laser': this.laser(m.id, m.pts, m.c); break;
      }
    }
  }

  // Auto-reconnecting WebSocket.
  function connect(onOpen, onMessage, onStatus) {
    let ws;
    const api = { send(o) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; } };
    function open() {
      onStatus && onStatus('connecting');
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => { onStatus && onStatus('online'); onOpen && onOpen(); };
      ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMessage(m); };
      ws.onclose = () => { onStatus && onStatus('offline'); setTimeout(open, 1500); };
      ws.onerror = () => { try { ws.close(); } catch (x) {} };
    }
    open();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ws && ws.readyState > 1) { try { ws.close(); } catch (x) {} }
    });
    return api;
  }

  return { Board, connect, BG };
})();
