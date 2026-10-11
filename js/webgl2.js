// swim in the browser: WebGL2 for swim_render_gl (src/swim_render_gl.c). The wasm module draws swim_render's output
// itself, with the same GL calls as on every other platform; this script only gives it those calls: the imports of
// module "gl", GL's C signatures over WebGL2 (integer names for WebGL's objects, pointers into the wasm memory).
(function () {
  "use strict";
  const SwimWeb = (globalThis.SwimWeb = globalThis.SwimWeb || {});

  const UNPACK_ROW_LENGTH = 0x0CF2, UNPACK_ALIGNMENT = 0x0CF5, COMPILE_STATUS = 0x8B81, LINK_STATUS = 0x8B82;
  const RED = 0x1903, RGBA = 0x1908;

  // one GL context: its objects by integer name (0 = none), the unpack state that sizes pixel uploads
  class GlContext {
    constructor(rt, gl) {
      this.rt = rt;
      this.gl = gl;
      this.objects = [null];
      this.free = [];
      this.rowLength = 0;
      this.alignment = 4;
    }

    get mem() { return this.rt.memory.buffer; }
    add(object) {
      const id = this.free.length ? this.free.pop() : this.objects.length;
      this.objects[id] = object;
      return id;
    }
    take(id) {
      const object = this.objects[id];
      if (id && object) {
        this.objects[id] = null;
        this.free.push(id);
      }
      return object;
    }
    cstring(ptr) {
      const bytes = new Uint8Array(this.mem, ptr);
      return this.rt.decoder.decode(bytes.subarray(0, bytes.indexOf(0)));
    }
    // GL's info log calls: the text into buf (bufSize with its NUL), its length into *length
    infoLog(text, bufSize, length, buf) {
      const bytes = this.rt.encoder.encode(text || "").subarray(0, Math.max(0, bufSize - 1));
      new Uint8Array(this.mem, buf, bytes.length + 1).set([...bytes, 0]);
      if (length) new Int32Array(this.mem, length, 1)[0] = bytes.length;
    }
    gen(n, out, make) {
      const ids = new Uint32Array(this.mem, out, n);
      for (let i = 0; i < n; i++) ids[i] = this.add(make());
    }
    del(n, ptr, remove) {
      const ids = new Uint32Array(this.mem, ptr, n);
      for (let i = 0; i < n; i++) {
        const object = this.take(ids[i]);
        if (object) remove(object);
      }
    }
    // the bytes an upload reads (GL_UNSIGNED_BYTE): rows of rowLength (or width) pixels, aligned, the last one unpadded
    pixels(width, height, format, ptr) {
      if (!ptr) return null;
      const bpp = format === RED ? 1 : format === RGBA ? 4 : 4;
      const align = this.alignment;
      const stride = Math.ceil(((this.rowLength || width) * bpp) / align) * align;
      return new Uint8Array(this.mem, ptr, stride * (height - 1) + width * bpp);
    }

    glCreateShader(type) { return this.add(this.gl.createShader(type)); }
    glShaderSource(shader, count, strings, lengths) {
      const u32 = new Uint32Array(this.mem, strings, count), lens = lengths ? new Int32Array(this.mem, lengths, count) : null;
      let source = "";
      for (let i = 0; i < count; i++) {
        source += lens && lens[i] >= 0 ? this.rt.string(u32[i], lens[i]) : this.cstring(u32[i]);
      }
      this.gl.shaderSource(this.objects[shader], source);
    }
    glCompileShader(shader) { this.gl.compileShader(this.objects[shader]); }
    glGetShaderiv(shader, pname, out) {
      const v = this.gl.getShaderParameter(this.objects[shader], pname);
      new Int32Array(this.mem, out, 1)[0] = pname === COMPILE_STATUS ? (v ? 1 : 0) : v | 0;
    }
    glGetShaderInfoLog(shader, bufSize, length, buf) { this.infoLog(this.gl.getShaderInfoLog(this.objects[shader]), bufSize, length, buf); }
    glDeleteShader(shader) { const s = this.take(shader); if (s) this.gl.deleteShader(s); }
    glCreateProgram() { return this.add(this.gl.createProgram()); }
    glAttachShader(program, shader) { this.gl.attachShader(this.objects[program], this.objects[shader]); }
    glLinkProgram(program) { this.gl.linkProgram(this.objects[program]); }
    glGetProgramiv(program, pname, out) {
      const v = this.gl.getProgramParameter(this.objects[program], pname);
      new Int32Array(this.mem, out, 1)[0] = pname === LINK_STATUS ? (v ? 1 : 0) : v | 0;
    }
    glGetProgramInfoLog(program, bufSize, length, buf) { this.infoLog(this.gl.getProgramInfoLog(this.objects[program]), bufSize, length, buf); }
    glDeleteProgram(program) { const p = this.take(program); if (p) this.gl.deleteProgram(p); }
    glUseProgram(program) { this.gl.useProgram(this.objects[program]); }
    // uniform locations are objects too: -1 when the program has none of that name
    glGetUniformLocation(program, name) {
      const location = this.gl.getUniformLocation(this.objects[program], this.cstring(name));
      return location ? this.add(location) : -1;
    }
    loc(id) { return id > 0 ? this.objects[id] : null; }
    glUniform1i(location, v) { this.gl.uniform1i(this.loc(location), v); }
    glUniform1f(location, v) { this.gl.uniform1f(this.loc(location), v); }
    glUniform2f(location, a, b) { this.gl.uniform2f(this.loc(location), a, b); }
    glUniform4fv(location, count, ptr) { this.gl.uniform4fv(this.loc(location), new Float32Array(this.mem, ptr, count * 4)); }
    glUniformMatrix3x2fv(location, count, transpose, ptr) {
      this.gl.uniformMatrix3x2fv(this.loc(location), !!transpose, new Float32Array(this.mem, ptr, count * 6));
    }
    glGenVertexArrays(n, out) { this.gen(n, out, () => this.gl.createVertexArray()); }
    glBindVertexArray(array) { this.gl.bindVertexArray(this.objects[array]); }
    glDeleteVertexArrays(n, ptr) { this.del(n, ptr, (o) => this.gl.deleteVertexArray(o)); }
    glGenBuffers(n, out) { this.gen(n, out, () => this.gl.createBuffer()); }
    glBindBuffer(target, buffer) { this.gl.bindBuffer(target, this.objects[buffer]); }
    glBufferData(target, size, ptr, usage) {
      if (ptr) {
        this.gl.bufferData(target, new Uint8Array(this.mem, ptr, size), usage);
      } else {
        this.gl.bufferData(target, size, usage);
      }
    }
    glDeleteBuffers(n, ptr) { this.del(n, ptr, (o) => this.gl.deleteBuffer(o)); }
    glEnableVertexAttribArray(index) { this.gl.enableVertexAttribArray(index); }
    glVertexAttribPointer(index, size, type, normalized, stride, offset) { this.gl.vertexAttribPointer(index, size, type, !!normalized, stride, offset); }
    glVertexAttribIPointer(index, size, type, stride, offset) { this.gl.vertexAttribIPointer(index, size, type, stride, offset); }
    glGenTextures(n, out) { this.gen(n, out, () => this.gl.createTexture()); }
    glBindTexture(target, texture) { this.gl.bindTexture(target, this.objects[texture]); }
    glDeleteTextures(n, ptr) { this.del(n, ptr, (o) => this.gl.deleteTexture(o)); }
    glTexImage2D(target, level, internalFormat, width, height, border, format, type, ptr) {
      this.gl.texImage2D(target, level, internalFormat, width, height, border, format, type, this.pixels(width, height, format, ptr));
    }
    glTexSubImage2D(target, level, x, y, width, height, format, type, ptr) {
      this.gl.texSubImage2D(target, level, x, y, width, height, format, type, this.pixels(width, height, format, ptr));
    }
    glTexParameteri(target, pname, param) { this.gl.texParameteri(target, pname, param); }
    glPixelStorei(pname, param) {
      if (pname === UNPACK_ROW_LENGTH) this.rowLength = param;
      if (pname === UNPACK_ALIGNMENT) this.alignment = param;
      this.gl.pixelStorei(pname, param);
    }
    glActiveTexture(texture) { this.gl.activeTexture(texture); }
    glViewport(x, y, w, h) { this.gl.viewport(x, y, w, h); }
    glScissor(x, y, w, h) { this.gl.scissor(x, y, w, h); }
    glEnable(cap) { this.gl.enable(cap); }
    glDisable(cap) { this.gl.disable(cap); }
    glBlendEquation(mode) { this.gl.blendEquation(mode); }
    glBlendFunc(s, d) { this.gl.blendFunc(s, d); }
    glClearColor(r, g, b, a) { this.gl.clearColor(r, g, b, a); }
    glClear(mask) { this.gl.clear(mask); }
    glDrawElements(mode, count, type, offset) { this.gl.drawElements(mode, count, type, offset); }
  }

  // The imports of module "gl", given when the module is instantiated: each calls the current context (rt.glContext,
  // replaced when the renderer switches). Fixed arity, so a call allocates nothing.
  SwimWeb.glImports = function (rt) {
    const imports = {};
    for (const name of Object.getOwnPropertyNames(GlContext.prototype)) {
      if (!name.startsWith("gl")) continue;
      imports[name] = (a, b, c, d, e, f, g, h, i) => rt.glContext[name](a, b, c, d, e, f, g, h, i);
    }
    return imports;
  };

  SwimWeb.WebGL2 = class WebGL2 {
    constructor(rt, gl) {
      this.kind = "webgl2";
      this.rt = rt;
      this.gl = gl;
    }

    setup() {
      this.rt.glContext = new GlContext(this.rt, this.gl);
      const x = this.rt.x;
      if (!x.sw_web_gl_setup()) throw new Error("swim_render_gl: " + this.rt.glContext.cstring(x.sw_web_gl_error()));
    }

    draw() {
      const canvas = this.rt.canvas;
      return this.rt.x.sw_web_gl_draw(canvas.width, canvas.height);
    }
  };
})();
