// swim in the browser, page half: loads the app's wasm (built with swim_web.c), sends it input, runs frames and
// hands each one to a renderer (canvas2d.js: the draw list with Canvas 2D, webgl2.js: the GL functions with which
// the module draws swim_render's buffers).
// A plain script (no modules, so a page opened from disk works): SwimWeb.start(options) once the three are loaded.
//
//     const app = await SwimWeb.start({
//       canvas: document.querySelector("canvas"),   // fills its parent; the parent takes the input
//       wasm: { url: "app.wasm" },                   // or base64, or bytes
//       families: [{ name: "sans", css: "system-ui, sans-serif" }, { name: "mono", css: "ui-monospace, monospace" }],
//       fonts: [{ family: "sans", style: 0, data: { url: "fonts/Sans-Regular.ttf" } }],
//       onFrame: (stats) => { ... },               // timing, command count, renderer
//       onRenderer: (kind) => { ... },             // the app switched renderers (sw_webRequestRenderer)
//     });
//
// Families are the names sw_webFont looks up; the first is the default. Fonts are TTF data for them (style: 0
// regular, 1 bold, 2 italic, 3 bold italic) or, with family null, fallbacks for other scripts in the order they
// fall back. WebGL2 shapes text with them in swim_render; Canvas 2D gets them as web fonts in front of each family's
// CSS stack, so both renderers show the same fonts (canvasFonts: false keeps Canvas 2D on the CSS stacks).
(function () {
  "use strict";
  const SwimWeb = (globalThis.SwimWeb = globalThis.SwimWeb || {});
  SwimWeb.SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif';

  // sw_key values (swim.h): named keys by KeyboardEvent.key, the rest by what the key types or, when a modifier
  // changed that (shift+1, option+a), by KeyboardEvent.code
  const KEYS = { Backspace: 1, Delete: 2, Enter: 3, Escape: 4, Tab: 5, ArrowLeft: 6, ArrowRight: 7, ArrowUp: 8, ArrowDown: 9,
                 Home: 10, End: 11, PageUp: 12, PageDown: 13, Insert: 14, " ": 15, ContextMenu: 112, CapsLock: 113,
                 ScrollLock: 114, NumLock: 115, PrintScreen: 116, Pause: 117 };
  const CODES = { Minus: 76, Equal: 77, BracketLeft: 78, BracketRight: 79, Backslash: 80, Semicolon: 81, Quote: 82,
                  Comma: 83, Period: 84, Slash: 85, Backquote: 86, NumpadDecimal: 97, NumpadDivide: 98, NumpadMultiply: 99,
                  NumpadSubtract: 100, NumpadAdd: 101, NumpadEnter: 102, NumpadEqual: 103, ShiftLeft: 104, ShiftRight: 105,
                  ControlLeft: 106, ControlRight: 107, AltLeft: 108, AltRight: 109, MetaLeft: 110, MetaRight: 111 };
  const PUNCT = { "-": 76, "=": 77, "[": 78, "]": 79, "\\": 80, ";": 81, "'": 82, ",": 83, ".": 84, "/": 85, "`": 86 };
  function swKey(e) {
    if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return CODES[e.code];
    if (e.key in KEYS) return KEYS[e.key];          // numpad with num lock off too (its arrows, home, ...)
    if (/^Numpad[0-9]$/.test(e.code)) return 87 + +e.code[6];
    if (e.code.startsWith("Numpad") && e.code in CODES) return CODES[e.code];
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return 51 + +e.key.slice(1);
    const k = e.key.length === 1 ? e.key.toLowerCase() : "";
    if (k >= "a" && k <= "z") return 16 + k.charCodeAt(0) - 97;
    if (k >= "0" && k <= "9") return 42 + k.charCodeAt(0) - 48;
    if (k in PUNCT) return PUNCT[k];
    if (/^Key[A-Z]$/.test(e.code)) return 16 + e.code.charCodeAt(3) - 65;
    if (/^Digit[0-9]$/.test(e.code)) return 42 + +e.code[5];
    return CODES[e.code] || 0;
  }
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const mods = (e) => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0) | ((MAC ? e.metaKey : e.ctrlKey) ? 16 : 0);
  const pointerKind = (e) => e.pointerType === "touch" ? 1 : e.pointerType === "pen" ? 2 : 0;
  const pointerButton = (e) => e.button === 2 ? 1 : e.button === 1 ? 2 : 0;
  const CURSORS = ["default", "pointer", "text", "ew-resize", "ns-resize", "move"];

  // a source of bytes: base64 text, { url }, an ArrayBuffer or a typed array
  async function bytesOf(source) {
    if (typeof source === "string") return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
    if (source && source.url) {
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`${source.url}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }

  class Runtime {
    constructor(options) {
      this.options = options;
      this.canvas = options.canvas;
      this.stage = this.canvas.parentElement;
      this.families = options.families && options.families.length ? options.families : [{ name: "sans", css: SwimWeb.SYSTEM_FONT }];
      this.fonts = options.fonts || [];
      this.decoder = new TextDecoder();
      this.encoder = new TextEncoder();
      this.meter = document.createElement("canvas").getContext("2d");
      this.renderer = null;
      this.dirty = true;
      this.paint = true;          // the canvas lost its pixels (resized, new context): draw even a reused frame
      this.last = performance.now();
      this.avg = 0;
      this.cssW = 1;
      this.cssH = 1;
      this.pxW = 0;
      this.pxH = 0;
      this.fontBytes = null;      // the TTF data, loaded once
      this.webFonts = null;       // Canvas 2D: the TTF data as web fonts, per family
    }

    // --- text for Canvas 2D: swim asks for the x of every byte boundary (bytes inside a character repeat its start)

    fontOf(size, style, font) {
      const family = this.families[font ? font - 1 : 0] || this.families[0];
      const css = this.webFonts && this.webFonts[family.name] ? `"${this.webFonts[family.name]}", ${family.css}` : family.css;
      return `${style & 2 ? "italic " : ""}${style & 1 ? 600 : 400} ${size}px ${css}`;
    }

    measure(ptr, size, fontSize, style, font, out) {
      const mem = this.memory.buffer;
      const bytes = new Uint8Array(mem, ptr, size);
      const offsets = new Float32Array(mem, out, size + 1);
      this.meter.font = this.fontOf(fontSize, style, font);
      let text = "";
      offsets[0] = 0;
      for (let i = 0; i < size;) {
        const b = bytes[i];
        const len = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
        text += this.decoder.decode(bytes.subarray(i, Math.min(size, i + len)));
        const w = this.meter.measureText(text).width;
        for (let k = 1; k < len && i + k < size; k++) offsets[i + k] = offsets[i];
        i += len;
        offsets[Math.min(i, size)] = w;
      }
    }

    metrics(fontSize, style, font, out) {
      this.meter.font = this.fontOf(fontSize, style, font);
      const m = this.meter.measureText("Hg");
      const ascent = m.fontBoundingBoxAscent ?? fontSize * 0.8;
      const descent = m.fontBoundingBoxDescent ?? fontSize * 0.2;
      new Float32Array(this.memory.buffer, out, 3).set([ascent, descent, Math.max(fontSize * 1.25, ascent + descent)]);
    }

    string(ptr, size) {
      return this.decoder.decode(new Uint8Array(this.memory.buffer, ptr, size));
    }

    // a string into the wasm side's scratch buffer (4 KB): its byte length
    toScratch(s) {
      const bytes = this.encoder.encode(s).subarray(0, 4096);
      new Uint8Array(this.memory.buffer, this.x.sw_web_scratch(), bytes.length).set(bytes);
      return bytes.length;
    }

    // --- loading

    async load() {
      const bytes = await bytesOf(this.options.wasm);
      const env = {
        sinf: Math.sin, cosf: Math.cos, powf: Math.pow, atan2f: Math.atan2, exp: Math.exp, fmodf: (a, b) => a % b,
        cbrtf: Math.cbrt, acosf: Math.acos,
        measure: (ptr, size, fontSize, style, font, out) => this.measure(ptr, size, fontSize, style, font, out),
        metrics: (fontSize, style, font, out) => this.metrics(fontSize, style, font, out),
        open_url: (ptr, size, newTab) => {
          const url = this.string(ptr, size);
          if (newTab) window.open(url, "_blank", "noopener");
          else location.assign(url);
        },
        copy: (ptr, size) => {
          const text = this.string(ptr, size);
          if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
        },
        set_title: (ptr, size) => { document.title = this.string(ptr, size); },
        // not while the frame that asks is being built: its context goes away
        set_renderer: (kind) => setTimeout(() => this.setRenderer(kind ? "webgl2" : "canvas2d").then((k) => this.options.onRenderer && this.options.onRenderer(k))),
        set_route: (ptr, size) => {
          const route = this.string(ptr, size);
          history.pushState(null, "", route ? "#" + route : location.pathname + location.search);
        },
      };
      // the GL functions swim_render_gl calls (js/webgl2.js; not there in a Canvas 2D only build, which needs none)
      const gl = SwimWeb.glImports ? SwimWeb.glImports(this) : {};
      const { instance } = await WebAssembly.instantiate(bytes, { env, gl });
      this.x = instance.exports;
      this.memory = this.x.memory;
      for (const family of this.families) this.x.sw_web_family(this.toScratch(family.name));
      this.sendRoute();
      this.fontBytes = await Promise.all(this.fonts.map((f) => bytesOf(f.data)));
    }

    // TTF data into the wasm heap for swim_render (once: the renderer keeps it); fallbacks first, regular faces
    // before the other styles
    loadRenderFonts() {
      if (this.renderFontsLoaded || !this.fonts.length) return;
      this.renderFontsLoaded = true;
      const order = this.fonts.map((f, i) => i).sort((a, b) =>
        ((this.fonts[a].family ? 1 : 0) - (this.fonts[b].family ? 1 : 0)) || ((this.fonts[a].style || 0) - (this.fonts[b].style || 0)));
      for (const i of order) {
        const font = this.fonts[i], data = this.fontBytes[i];
        const ptr = this.x.sw_web_alloc(data.length);
        new Uint8Array(this.memory.buffer, ptr, data.length).set(data);
        if (font.family) {
          const family = this.families.findIndex((f) => f.name === font.family);
          if (family >= 0) this.x.sw_web_font_face(family, font.style || 0, ptr, data.length);
        } else {
          this.x.sw_web_font_fallback(ptr, data.length);
        }
      }
    }

    // the families' TTF data as web fonts for Canvas 2D (fallbacks stay the browser's)
    async loadWebFonts() {
      if (this.webFonts || this.options.canvasFonts === false || !("FontFace" in window)) return;
      const names = {}, loads = [];
      this.fonts.forEach((font, i) => {
        if (!font.family) return;
        const name = (names[font.family] = `swim-${font.family}`);
        const style = font.style || 0;
        const face = new FontFace(name, this.fontBytes[i], { weight: style & 1 ? "700" : "400", style: style & 2 ? "italic" : "normal" });
        document.fonts.add(face);
        loads.push(face.load().catch(() => {}));
      });
      await Promise.all(loads);
      this.webFonts = names;
    }

    // --- renderers

    // "webgl2" or "canvas2d" ("auto": WebGL2 when the browser has it and there are fonts for swim_render). A canvas
    // has one kind of context for life, so switching replaces it; swim restarts with the other text backend.
    async setRenderer(kind) {
      const wantGl = kind !== "canvas2d" && this.fonts.some((f) => f.family === this.families[0].name);
      if (!wantGl) await this.loadWebFonts();
      const next = this.canvas.cloneNode(false);
      this.canvas.replaceWith(next);
      this.canvas = next;
      let renderer = null;
      if (wantGl && SwimWeb.WebGL2) {
        const gl = this.canvas.getContext("webgl2", { antialias: true, alpha: false, premultipliedAlpha: true });
        if (gl) {
          this.loadRenderFonts();
          renderer = new SwimWeb.WebGL2(this, gl);
        }
      }
      if (!renderer) {
        if (wantGl) await this.loadWebFonts();
        renderer = new SwimWeb.Canvas2D(this, this.canvas.getContext("2d"));
      }
      this.x.sw_web_start(this.dark() ? 1 : 0, renderer.kind === "webgl2" ? 1 : 0);
      if (renderer.setup) renderer.setup();
      this.renderer = renderer;
      this.pxW = 0;
      this.resize();
      return renderer.kind;
    }

    // --- page state

    dark() {
      const theme = document.documentElement.getAttribute("data-theme");
      return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    }

    sendRoute() {
      this.x.sw_web_route(this.toScratch(decodeURIComponent(location.hash.slice(1))));
      this.dirty = true;
    }

    // --- input: pointer, wheel, keys and typed text go to swim as events for the next frame

    point(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    sendText(s) {
      this.x.sw_web_text(this.toScratch(s));
      this.dirty = true;
    }

    listen() {
      const stage = this.stage, x = this.x;
      stage.addEventListener("pointermove", (e) => {
        const [px, py] = this.point(e);
        x.sw_web_pointer(0, px, py, 0, mods(e), pointerKind(e));
        this.dirty = true;
      });
      stage.addEventListener("pointerdown", (e) => {
        this.canvas.focus({ preventScroll: true });
        this.canvas.setPointerCapture(e.pointerId);
        const [px, py] = this.point(e);
        x.sw_web_pointer(1, px, py, pointerButton(e), mods(e), pointerKind(e));
        this.dirty = true;
      });
      stage.addEventListener("pointerup", (e) => {
        const [px, py] = this.point(e);
        x.sw_web_pointer(2, px, py, pointerButton(e), mods(e), pointerKind(e));
        this.dirty = true;
      });
      stage.addEventListener("pointerleave", (e) => {
        const [px, py] = this.point(e);
        x.sw_web_pointer(3, px, py, 0, 0, pointerKind(e));
        this.dirty = true;
      });
      stage.addEventListener("wheel", (e) => {
        e.preventDefault();
        // swim scrolls what is under the pointer: where the wheel turned, even without a move before it
        const [px, py] = this.point(e);
        x.sw_web_pointer(0, px, py, 0, mods(e), 0);
        const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        x.sw_web_wheel(-e.deltaX * k, -e.deltaY * k);
        this.dirty = true;
      }, { passive: false });
      stage.addEventListener("contextmenu", (e) => e.preventDefault());
      stage.addEventListener("keydown", (e) => {
        const command = MAC ? e.metaKey : e.ctrlKey;
        const key = swKey(e);
        if (key) x.sw_web_key(1, key, mods(e), e.repeat ? 1 : 0);
        if (e.key.length === 1 && !command && !e.ctrlKey) this.sendText(e.key);
        // keep the browser's own shortcuts (reload, dev tools, ...) unless a text field uses them; the paste event
        // brings Cmd+V's text
        const functionKey = key >= 52 && key <= 75;
        const plain = !command && !e.ctrlKey;
        const fieldShortcut = command && "abiucxyz".includes(e.key.toLowerCase());
        if (((key || e.key.length === 1) && plain && !functionKey) || fieldShortcut) e.preventDefault();
        this.dirty = true;
      });
      stage.addEventListener("keyup", (e) => {
        const key = swKey(e);
        if (key) x.sw_web_key(0, key, mods(e), 0);
        this.dirty = true;
      });
      stage.addEventListener("paste", (e) => {
        const text = e.clipboardData && e.clipboardData.getData("text/plain");
        if (text) this.sendText(text);
        e.preventDefault();
      });
      window.addEventListener("blur", () => {
        x.sw_web_focus_lost();
        this.dirty = true;
      });
      window.addEventListener("hashchange", () => this.sendRoute());
      const scheme = () => {
        x.sw_web_color_scheme(this.dark() ? 1 : 0);
        this.dirty = true;
      };
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", scheme);
      new MutationObserver(scheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // The canvas follows the stage. Setting its size clears it, and a ResizeObserver runs after this frame's
      // requestAnimationFrame, so it draws right away: the cleared canvas is never shown (no flicker while dragging
      // the window's edge). Sizes come from the observer: the CSS size swim lays out for, and the exact device
      // pixels when the browser reports them (no blur from rounding at fractional zoom). Observing device pixels
      // also catches a scale change (the window moved to another display); Safari lacks it.
      const observer = new ResizeObserver((entries) => this.resize(entries[entries.length - 1]));
      try {
        observer.observe(stage, { box: "device-pixel-content-box" });
      } catch {
        observer.observe(stage);
      }
    }

    resize(entry) {
      if (entry || !this.pxW) {
        const dpr = window.devicePixelRatio || 1;
        this.cssW = entry ? entry.contentRect.width : this.stage.clientWidth;
        this.cssH = entry ? entry.contentRect.height : this.stage.clientHeight;
        const box = entry && entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
        this.pxW = Math.max(1, box ? box.inlineSize : Math.round(this.cssW * dpr));
        this.pxH = Math.max(1, box ? box.blockSize : Math.round(this.cssH * dpr));
      }
      if (this.canvas.width !== this.pxW || this.canvas.height !== this.pxH) {
        this.canvas.width = this.pxW;
        this.canvas.height = this.pxH;
        this.paint = true;
        if (this.renderer) this.frame(performance.now());
      }
      this.dirty = true;
    }

    // --- frames: drawn when something happened or swim is animating

    // `now` is a requestAnimationFrame stamp (the frame's start) or performance.now() (a resize, later in the
    // frame): the clock only moves forward, so the frame after a resize doesn't go back in time
    frame(now) {
      const x = this.x;
      const dt = Math.min(0.1, Math.max(0, now - this.last) / 1000);
      this.last = Math.max(this.last, now);
      this.dirty = false;
      const dpr = window.devicePixelRatio || 1;
      const t0 = performance.now();
      const count = x.sw_web_frame(Math.max(1, this.cssW), Math.max(1, this.cssH), dt, dpr);
      const t1 = performance.now();
      let drawCalls = 0;
      if (this.paint || !x.sw_web_frame_reused()) {
        drawCalls = this.renderer.draw(count, dpr, x.sw_web_clear_color());
        this.paint = false;
      }
      this.avg = this.avg ? this.avg * 0.9 + (t1 - t0) * 0.1 : t1 - t0;
      this.canvas.style.cursor = CURSORS[x.sw_web_cursor()] || "default";
      if (this.options.onFrame) {
        this.options.onFrame({ ms: this.avg, commands: count, drawCalls, renderer: this.renderer.kind, memory: this.memory.buffer.byteLength });
      }
    }

    tick(now) {
      if (this.dirty || this.x.sw_web_needs_redraw()) {
        this.frame(now);
      } else {
        this.last = Math.max(this.last, now);
      }
      requestAnimationFrame((t) => this.tick(t));
    }
  }

  // Starts an app: resolves to its runtime (runtime.setRenderer(kind) switches, runtime.renderer.kind says which
  // one draws).
  SwimWeb.start = async function (options) {
    const rt = new Runtime(options);
    await rt.load();
    await rt.setRenderer(options.renderer || "auto");
    rt.listen();
    requestAnimationFrame((t) => rt.tick(t));
    return rt;
  };
})();
