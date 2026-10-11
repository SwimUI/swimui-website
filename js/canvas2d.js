// swim in the browser: the draw list drawn with Canvas 2D (text measured and drawn by the browser). Reads the
// commands swim_web.c serialized (20 words each) and the draw list's tables from wasm memory.
(function () {
  "use strict";
  const SwimWeb = (globalThis.SwimWeb = globalThis.SwimWeb || {});
  const color = (c) => `rgba(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255},${((c >>> 24) & 255) / 255})`;

  SwimWeb.Canvas2D = class Canvas2D {
    constructor(rt, g) {
      this.kind = "canvas2d";
      this.rt = rt;
      this.g = g;
    }

    roundRect(x0, y0, w, h, r) {
      const half = Math.max(0, Math.min(w, h) / 2);
      this.g.beginPath();
      this.g.roundRect(x0, y0, Math.max(0, w), Math.max(0, h), r.map((v) => Math.max(0, Math.min(v, half))));
    }

    // a draw list path as a Path2D, its viewBox mapped to the rect
    pathOf(index, rx, ry, rw, rh) {
      const x = this.rt.x, mem = this.rt.memory.buffer;
      const pv = x.sw_web_paths() + index * 48, view = new DataView(mem);
      const vx = view.getFloat32(pv + 8, true), vy = view.getFloat32(pv + 12, true), vw = view.getFloat32(pv + 16, true), vh = view.getFloat32(pv + 20, true);
      const verbStart = view.getUint32(pv + 24, true), verbCount = view.getUint32(pv + 28, true), pointStart = view.getUint32(pv + 32, true);
      const verbs = new Uint8Array(mem, x.sw_web_path_verbs() + verbStart, verbCount);
      const pts = x.sw_web_path_points() + pointStart * 8;
      const sx = rw / vw, sy = rh / vh;
      const px = (k) => rx + (view.getFloat32(pts + k * 8, true) - vx) * sx, py = (k) => ry + (view.getFloat32(pts + k * 8 + 4, true) - vy) * sy;
      const p = new Path2D();
      let k = 0;
      for (const v of verbs) {
        if (v === 0) {
          p.moveTo(px(k), py(k));
          k += 1;
        } else if (v === 1) {
          p.lineTo(px(k), py(k));
          k += 1;
        } else if (v === 2) {
          p.quadraticCurveTo(px(k), py(k), px(k + 1), py(k + 1));
          k += 2;
        } else {
          p.closePath();
        }
      }
      return [p, view.getUint8(pv + 40) ? "evenodd" : "nonzero"];
    }

    // sw_Gradient: 6 stops of { rgba, location }, stopCount, angle (56 bytes)
    fillStyleOf(rx, ry, rw, rh, c1, gradient) {
      if (!gradient) return color(c1);
      const view = new DataView(this.rt.memory.buffer), pg = this.rt.x.sw_web_gradients() + gradient * 56;
      const a = (view.getFloat32(pg + 52, true) * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
      const half = (Math.abs(rw * dx) + Math.abs(rh * dy)) / 2, cx = rx + rw / 2, cy = ry + rh / 2;
      const grad = this.g.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
      const n = view.getUint32(pg + 48, true);
      for (let k = 0; k < n; k++) grad.addColorStop(view.getFloat32(pg + k * 8 + 4, true), color(view.getUint32(pg + k * 8, true)));
      return grad;
    }

    // A blurred fill (soft edges, shadows) with the canvas's shadow, which every browser has (ctx.filter isn't in
    // all of them): the shape is filled far off to the left and only its shadow is moved back into place.
    // softness / 2 is the Gaussian's sigma (as swim_render draws it), shadowBlur twice that, in device pixels.
    softFill(fill, soft, color) {
      const g = this.g, m = g.getTransform(), far = 100000;
      g.save();
      g.shadowColor = color;
      g.shadowBlur = soft * Math.hypot(m.a, m.b);
      g.shadowOffsetX = far * m.a;
      g.shadowOffsetY = far * m.b;
      g.translate(-far, 0);
      fill();
      g.restore();
    }

    draw(count, dpr, clear) {
      const g = this.g, rt = this.rt, x = rt.x, mem = rt.memory.buffer;
      const base = x.sw_web_commands();
      const u32 = new Uint32Array(mem, base, count * 20);
      const f32 = new Float32Array(mem, base, count * 20);
      const clips = new Float32Array(mem, x.sw_web_clips(), x.sw_web_clip_count() * 14);
      const clipU32 = new Uint32Array(mem, x.sw_web_clips(), x.sw_web_clip_count() * 14);
      const transforms = x.sw_web_transforms();
      const textBase = x.sw_web_text_bytes();
      const view = new DataView(mem);

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = color(clear | 0xff000000);
      g.fillRect(0, 0, rt.canvas.width, rt.canvas.height);
      for (let i = 0; i < count; i++) {
        const o = i * 20;
        const kind = u32[o], clip = u32[o + 1], xf = u32[o + 2];
        const rx = f32[o + 3], ry = f32[o + 4], rw = f32[o + 5], rh = f32[o + 6];
        g.save();
        if (clip) {
          const c = clip * 14;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          this.roundRect(clips[c], clips[c + 1], clips[c + 2], clips[c + 3], [clips[c + 4], clips[c + 5], clips[c + 6], clips[c + 7]]);
          g.clip();
          if (clipU32[c + 8]) {
            // the path in the clipping node's space: its transform (rotation, scale) applies
            const pxf = clipU32[c + 13] & 0xffff;
            if (pxf) {
              const m = new Float32Array(mem, transforms + pxf * 24, 6);
              g.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
            }
            const [p, rule] = this.pathOf(clipU32[c + 8], clips[c + 9], clips[c + 10], clips[c + 11], clips[c + 12]);
            g.clip(p, rule);
          }
        }
        if (xf) {
          const m = new Float32Array(mem, transforms + xf * 24, 6);
          g.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
        } else {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        if (kind === 0) {
          const radii = [f32[o + 10], f32[o + 11], f32[o + 12], f32[o + 13]];
          const border = f32[o + 14], soft = f32[o + 15];
          if (soft > 0 && (u32[o + 7] >>> 24)) {
            this.softFill(() => {
              this.roundRect(rx, ry, rw, rh, radii);
              g.fill();
            }, soft, color(u32[o + 7]));
          } else if ((u32[o + 7] >>> 24) || u32[o + 8]) {
            g.fillStyle = this.fillStyleOf(rx, ry, rw, rh, u32[o + 7], u32[o + 8]);
            this.roundRect(rx, ry, rw, rh, radii);
            g.fill();
          }
          if (border > 0 && (u32[o + 9] >>> 24)) {
            this.roundRect(rx + border / 2, ry + border / 2, rw - border, rh - border, radii.map((v) => v - border / 2));
            g.lineWidth = border;
            g.strokeStyle = color(u32[o + 9]);
            g.stroke();
          }
        } else if (kind === 1) {
          const text = rt.decoder.decode(new Uint8Array(mem, textBase + u32[o + 11], u32[o + 12]));
          g.font = rt.fontOf(f32[o + 8], u32[o + 9], u32[o + 16]);
          if (u32[o + 14]) {
            const grad = g.createLinearGradient(rx, 0, rx + rw, 0);
            grad.addColorStop(0, color(u32[o + 7]));
            grad.addColorStop(1, color(u32[o + 13]));
            g.fillStyle = grad;
          } else {
            g.fillStyle = color(u32[o + 7]);
          }
          g.textBaseline = "alphabetic";
          g.direction = u32[o + 15] ? "rtl" : "ltr";   // one run per direction, swim placed them in visual order
          g.textAlign = "left";
          g.fillText(text, rx, ry + f32[o + 10]);
        } else if (kind === 4) {
          const [p, rule] = this.pathOf(u32[o + 10], rx, ry, rw, rh);
          const border = f32[o + 11], soft = f32[o + 12];
          if (soft > 0 && (u32[o + 7] >>> 24)) {
            this.softFill(() => g.fill(p, rule), soft, color(u32[o + 7]));
          } else if ((u32[o + 7] >>> 24) || u32[o + 8]) {
            g.fillStyle = this.fillStyleOf(rx, ry, rw, rh, u32[o + 7], u32[o + 8]);
            g.fill(p, rule);
          }
          if (border > 0 && (u32[o + 9] >>> 24)) {
            // inside the outline, as swim_render draws it: clipped to the path, stroked twice as wide
            g.save();
            g.clip(p, rule);
            g.lineWidth = border * 2;
            g.strokeStyle = color(u32[o + 9]);
            g.stroke(p);
            g.restore();
          }
        } else if (kind === 3) {
          // one path per run of same-colored triangles: separately filled, their anti-aliased edges leave seams
          const start = u32[o + 7], n = u32[o + 8], vb = x.sw_web_vertices();
          let runColor = -1;
          for (let k = 0; k + 2 < n; k += 3) {
            const at = (v) => vb + (start + k + v) * 12;
            const c = view.getUint32(at(0) + 8, true);
            if (c !== runColor) {
              if (runColor !== -1) g.fill();
              g.beginPath();
              g.fillStyle = color(c);
              runColor = c;
            }
            g.moveTo(view.getFloat32(at(0), true), view.getFloat32(at(0) + 4, true));
            g.lineTo(view.getFloat32(at(1), true), view.getFloat32(at(1) + 4, true));
            g.lineTo(view.getFloat32(at(2), true), view.getFloat32(at(2) + 4, true));
            g.closePath();
          }
          if (runColor !== -1) g.fill();
        }
        g.restore();
      }
      return count;
    }
  };
})();
