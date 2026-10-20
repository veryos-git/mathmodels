const vertexSource = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const uniformsSource = `precision highp float;
precision highp int;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_duration;
uniform int u_frame;
`;
const particleFragment = `#version 300 es
precision highp float;
in vec4 particleColor;
out vec4 fragColor;
void main() {
    float radius = length(gl_PointCoord * 2.0 - 1.0);
    float alpha = (1.0 - smoothstep(0.65, 1.0, radius)) * particleColor.a;
    if (alpha <= 0.001) discard;
    fragColor = vec4(particleColor.rgb, alpha);
}`;

export class ShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!this.gl)
      throw new Error(
        "WebGL 2 is unavailable. Enable hardware acceleration or try a WebGL 2 compatible browser.",
      );
    this.program = null;
    this.particleProgram = null;
    this.vertex = this.createShader(this.gl.VERTEX_SHADER, vertexSource);
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
    this.maxResolution = Math.min(
      this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE),
      ...this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS),
    );
  }

  linkProgram(vertex, fragment) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || "Shader linking failed.";
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  locations(program) {
    return Object.fromEntries(
      ["u_resolution", "u_time", "u_duration", "u_frame"].map((name) => [
        name,
        this.gl.getUniformLocation(program, name),
      ]),
    );
  }

  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || "Shader compilation failed.");
    }
    return shader;
  }

  compile(sdf, visualization, { commit = true } = {}) {
    const gl = this.gl;
    const header = `#version 300 es\n${uniformsSource}out vec4 fragColor;\n`;
    this.sections = {
      sdf: { start: header.split("\n").length, count: sdf.split("\n").length },
      visualization: {
        start: header.split("\n").length + sdf.split("\n").length,
        count: visualization.split("\n").length,
      },
    };
    const source =
      header +
      sdf +
      "\n" +
      visualization +
      `
void main() {
  vec2 p = (2.0 * gl_FragCoord.xy - u_resolution) / min(u_resolution.x, u_resolution.y);
  float d = sdf(p);
  fragColor = vec4(clamp(shade(p, d), 0.0, 1.0), 1.0);
}`;
    let fragment;
    let program;
    let particleProgram, particleVertex, particleFragmentShader;
    try {
      fragment = this.createShader(gl.FRAGMENT_SHADER, source);
      program = this.linkProgram(this.vertex, fragment);
      const particles = visualization.match(
        /\/\/ @particles-begin\r?\n([\s\S]*?)\/\/ @particles-end/,
      );
      if (visualization.includes("// @particles-begin") && !particles)
        throw new Error(
          "The particle block needs a matching // @particles-end marker.",
        );
      if (particles) {
        const particleLine =
          visualization.slice(0, particles.index).split("\n").length + 1;
        // #line keeps vertex-pass errors mapped to the same editor lines as the fragment pass.
        const vertex = `#version 300 es
${uniformsSource}
#line ${this.sections.sdf.start}
${sdf}
#line ${this.sections.visualization.start + particleLine - 1}
${particles[1]}
out vec4 particleColor;
void main() {
    vec2 cell = vec2(float(gl_VertexID % 48), float(gl_VertexID / 48));
    vec2 seed = (cell + 0.5) / 24.0 - 1.0;
    vec4 particle = stParticle(seed);
    float scale = min(u_resolution.x, u_resolution.y);
    gl_Position = vec4(particle.xy * scale / u_resolution, 0.0, 1.0);
    gl_PointSize = max(1.0, particle.z * scale);
    particleColor = vec4(stParticleColor(seed), clamp(particle.w, 0.0, 1.0));
}`;
        particleVertex = this.createShader(gl.VERTEX_SHADER, vertex);
        particleFragmentShader = this.createShader(
          gl.FRAGMENT_SHADER,
          particleFragment,
        );
        particleProgram = this.linkProgram(
          particleVertex,
          particleFragmentShader,
        );
      }
      if (!commit) {
        gl.deleteProgram(program);
        if (particleProgram) gl.deleteProgram(particleProgram);
        return { ok: true, errors: [] };
      }
      if (this.program) gl.deleteProgram(this.program);
      if (this.particleProgram) gl.deleteProgram(this.particleProgram);
      this.program = program;
      this.sources = {
        vertex: vertexSource,
        fragment: source,
        particleVertex: particleVertex ? gl.getShaderSource(particleVertex) : null,
        particleFragment: particleVertex ? particleFragment : null,
      };
      this.uniforms = this.locations(program);
      this.particleProgram = particleProgram || null;
      this.particleUniforms = particleProgram
        ? this.locations(particleProgram)
        : null;
      return { ok: true, errors: [] };
    } catch (error) {
      if (program) gl.deleteProgram(program);
      if (particleProgram) gl.deleteProgram(particleProgram);
      const errors = error.message
        .split("\n")
        .filter(Boolean)
        .map((message) => {
          const match = message.match(/ERROR:\s*\d+:(\d+):\s*(.*)/);
          if (!match) return { message };
          const generatedLine = Number(match[1]);
          for (const [kind, section] of Object.entries(this.sections)) {
            if (
              generatedLine >= section.start &&
              generatedLine < section.start + section.count
            )
              return {
                kind,
                line: generatedLine - section.start + 1,
                message: match[2],
              };
          }
          return { message: match[2] };
        });
      return { ok: false, errors };
    } finally {
      if (fragment) gl.deleteShader(fragment);
      if (particleVertex) gl.deleteShader(particleVertex);
      if (particleFragmentShader) gl.deleteShader(particleFragmentShader);
    }
  }

  resize(width, height) {
    if (width > this.maxResolution || height > this.maxResolution)
      throw new Error(
        `This GPU supports canvas sizes up to ${this.maxResolution} pixels.`,
      );
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  setUniforms(program, locations, time, duration, frame) {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform2f(locations.u_resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(locations.u_time, time);
    gl.uniform1f(locations.u_duration, duration);
    gl.uniform1i(locations.u_frame, frame);
  }

  render(time, duration, frame = 0) {
    if (!this.program || this.gl.isContextLost()) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.setUniforms(this.program, this.uniforms, time, duration, frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.particleProgram) {
      this.setUniforms(
        this.particleProgram,
        this.particleUniforms,
        time,
        duration,
        frame,
      );
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, 48 * 48);
      gl.disable(gl.BLEND);
    }
  }

  dispose() {
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.particleProgram) gl.deleteProgram(this.particleProgram);
    gl.deleteShader(this.vertex);
    gl.deleteVertexArray(this.vao);
    this.program = this.particleProgram = this.sources = null;
  }

  readPixels(target) {
    const gl = this.gl;
    if (gl.isContextLost())
      throw new Error(
        "The graphics context was lost. Reload the page to render again.",
      );
    gl.readPixels(
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      target,
    );
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error(
        "Could not read the rendered frame. Try a smaller resolution.",
      );
    return target;
  }
}
