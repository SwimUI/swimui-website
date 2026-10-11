// swim in the browser: swim_render's output drawn with WebGL2, what any GPU backend does with sw_RenderData: apply
// the atlas texture updates, upload the frame's vertex and index buffers, one draw per command with its texture,
// scissor and clip. The shader is swim_render_glsl.h's, read from the wasm module.
(function () {
  "use strict";
  const SwimWeb = (globalThis.SwimWeb = globalThis.SwimWeb || {});

  SwimWeb.WebGL2 = class WebGL2 {
    constructor(rt, gl) {
      this.kind = "webgl2";
      this.rt = rt;
      this.gl = gl;
    }

    setup() {
      const gl = this.gl, x = this.rt.x;
      const source = (stage) => "#version 300 es\n" + this.rt.string(x.sw_web_shader(stage), x.sw_web_shader_size(stage));
      const shader = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, source(0)));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, source(1)));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer(), ibo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
      // sw_RenderVertex, 72 bytes
      const F = gl.FLOAT, B = gl.UNSIGNED_BYTE;
      [[0, 2, F, 0], [1, 2, F, 8], [2, 4, B, 16], [3, 4, B, 20], [4, 2, F, 24], [5, 2, F, 32], [6, 4, F, 40], [7, 3, F, 56]].forEach(([loc, n, type, at]) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, n, type, type === B, 72, at);
      });
      gl.enableVertexAttribArray(8);
      gl.vertexAttribIPointer(8, 1, gl.UNSIGNED_INT, 72, 68);
      const white = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, white);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      const u = (name) => gl.getUniformLocation(program, name);
      Object.assign(this, {
        program, vao, vbo, ibo, white, pages: [],
        uScreen: u("uScreen"), uClipRect: u("uClipRect"), uClipRadii: u("uClipRadii"), uTexture: u("uTexture"),
        uClipMask: u("uClipMask"), uClipMaskScale: u("uClipMaskScale"), uClipMaskTransform: u("uClipMaskTransform"),
        uClipMaskUv: u("uClipMaskUv"), uGammaBlend: u("uGammaBlend"),
      });
    }

    draw(count, dpr, clear) {
      const gl = this.gl, rt = this.rt;
      const d = rt.x.sw_web_render();
      if (!d) return 0;
      const mem = rt.memory.buffer;   // after building: it may have grown the memory (a new buffer)
      const u32 = new Uint32Array(mem), i32 = new Int32Array(mem), f32 = new Float32Array(mem);
      const w = d >> 2;
      const [vertices, vertexCount, indices, indexCount, cmds, cmdCount, updates, updateCount] = u32.subarray(w, w + 8);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      for (let i = 0; i < updateCount; i++) {
        const o = (updates + i * 44) >> 2;
        const [type, page, tw, th] = u32.subarray(o, o + 4);
        if (type === 0) {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, tw, th, 0, gl.RED, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          this.pages[page] = tex;
        } else if (type === 1) {
          const [rx, ry, rw, rh] = i32.subarray(o + 5, o + 9);
          const pixels = u32[o + 9], pitch = u32[o + 10];
          gl.bindTexture(gl.TEXTURE_2D, this.pages[page]);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, pitch);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, rx, ry, rw, rh, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(mem, pixels, pitch * (rh - 1) + rw));
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        } else {
          gl.deleteTexture(this.pages[page]);
          this.pages[page] = null;
        }
      }
      const canvas = rt.canvas;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor((clear & 255) / 255, ((clear >>> 8) & 255) / 255, ((clear >>> 16) & 255) / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(mem, vertices, vertexCount * 72), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mem, indices, indexCount), gl.STREAM_DRAW);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.SCISSOR_TEST);
      gl.uniform2f(this.uScreen, canvas.width, canvas.height);
      gl.uniform1f(this.uGammaBlend, 1);   // the canvas blends in sRGB values
      gl.uniform1i(this.uTexture, 0);
      gl.uniform1i(this.uClipMask, 1);
      for (let i = 0; i < cmdCount; i++) {
        const o = (cmds + i * 116) >> 2;
        const kind = u32[o], page = u32[o + 1];
        const [sx, sy, sw, sh] = i32.subarray(o + 3, o + 7);
        if (sw <= 0 || sh <= 0) continue;
        const maskScale = f32[o + 17];
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskScale > 0 ? this.pages[u32[o + 18]] : this.white);
        gl.uniform1f(this.uClipMaskScale, maskScale);
        gl.uniformMatrix3x2fv(this.uClipMaskTransform, false, f32.subarray(o + 19, o + 25));
        gl.uniform4fv(this.uClipMaskUv, f32.subarray(o + 25, o + 29));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, kind === 1 ? this.pages[page] : this.white);
        gl.scissor(sx, canvas.height - sy - sh, sw, sh);
        gl.uniform4fv(this.uClipRect, f32.subarray(o + 7, o + 11));
        gl.uniform4fv(this.uClipRadii, f32.subarray(o + 11, o + 15));
        gl.drawElements(gl.TRIANGLES, u32[o + 16], gl.UNSIGNED_INT, u32[o + 15] * 4);
      }
      return cmdCount;
    }
  };
})();
