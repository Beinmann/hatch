// GLSL for the rain-on-glass effect (WebGL1). The water map (public/fx/rain-raster.js) says where drops are and how their surface slopes;
// here each drop pixel looks through the drop at the real page background (image or colour, plus the terminal tint over it), bent and
// turned upside down like a tiny lens, then adds a dark upper rim, a lighter lower inner edge and a specular glint. Between the drops a very
// faint, blurred background rain falls behind the glass. Terminal text is not in the picture: it stays crisp on top of this canvas.
export const VERT = `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMap; uniform sampler2D uBg;
uniform vec2 uRes; uniform vec4 uBgX; uniform vec4 uTint; uniform vec3 uBase;
uniform float uHasImg, uTile, uAlpha, uTime, uRain;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

// one lane family of soft falling streaks: a blurred line per cell, only some cells lit, each moving at its own speed
float streaks(vec2 p, float cell, float wid, float len, float speed, float seed) {
  float cx = floor(p.x / cell), h = hash(vec2(cx, seed));
  float lane = abs(p.x - (cx + 0.15 + 0.7 * hash(vec2(cx, seed + 7.0))) * cell);
  float y = p.y / len - uTime * speed * (0.6 + 0.8 * h) + h * 17.0;
  float ph = fract(y), on = step(0.62, hash(vec2(cx, floor(y) + seed)));
  return smoothstep(wid, 0.0, lane) * smoothstep(0.0, 0.1, ph) * pow(1.0 - ph, 3.0) * on;
}
float rain(vec2 p) { return streaks(p, 41.0, 3.5, 190.0, 1.5, 1.0) * 0.7 + streaks(p, 67.0, 5.5, 260.0, 1.1, 2.0) * 0.9 + streaks(p, 29.0, 2.5, 140.0, 2.0, 3.0) * 0.5; }

vec3 scene(vec2 p) { // what a viewer sees at canvas pixel p without the glass: page background under the terminal tint, plus faint rain
  vec2 uv = p * uBgX.xy + uBgX.zw;
  uv = mix(clamp(uv, 0.0, 1.0), fract(uv), uTile);
  vec3 c = uHasImg > 0.5 ? texture2D(uBg, uv).rgb : uBase * (0.78 + 0.5 * (1.0 - p.y / uRes.y)); // plain colour: a soft light-to-dark sky so there is something to bend
  c = mix(c, uTint.rgb, uTint.a);
  return c + vec3(0.7, 0.8, 0.92) * rain(p) * uRain;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec4 m = texture2D(uMap, px / uRes);
  float rainA = rain(px) * uRain * 0.9; // the faint streaks between the drops (the only thing painted on dry glass)
  if (m.a < 0.004) { gl_FragColor = vec4(vec3(0.72, 0.8, 0.9) * rainA, rainA); return; }
  vec2 n = m.rg * 2.0 - 1.0; float rho = min(1.0, length(n)), R = max(m.b * 24.0, 1.0), h = sqrt(max(0.0, 1.0 - rho * rho));
  // a drop is a lens: the picture inside is flipped and shrunk (more so for the big ones), with a hint of colour fringing at the edge
  float k = 1.4 + 1.6 * clamp(R / 10.0, 0.0, 1.0), disp = 0.05 * rho;
  vec3 col = vec3(scene(px - n * R * k * (1.0 + disp)).r, scene(px - n * R * k).g, scene(px - n * R * k * (1.0 - disp)).b);
  vec3 N = vec3(n, h);
  float glint = pow(max(dot(N, normalize(vec3(-0.5, -0.6, 0.62))), 0.0), 55.0);
  float back = pow(max(dot(N, normalize(vec3(0.4, 0.55, 0.7))), 0.0), 24.0); // light coming through to the lower inside
  float rim = smoothstep(0.5, 0.98, rho), up = clamp(0.5 - 0.5 * n.y / max(rho, 0.05), 0.0, 1.0); // up = 1 on the upper edge
  col *= 1.0 - rim * mix(0.2, 0.72, up);
  col += vec3(0.85, 0.92, 1.0) * (back * 0.4 + rim * (1.0 - up) * 0.2 * h + 0.03 * h) * min(uAlpha, 1.5);
  col += vec3(1.0) * glint * (0.35 + 0.65 * clamp(R / 4.0, 0.0, 1.0)) * min(uAlpha, 1.5);
  col = mix(vec3(dot(col, vec3(0.3, 0.59, 0.11))), col, 1.05) * (0.92 + 0.12 * h);
  float a = m.a * clamp(uAlpha, 0.0, 1.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * a, a);
}`;
