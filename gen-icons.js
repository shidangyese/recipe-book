/* 一次性脚本：纯 Node 生成应用图标（无需任何依赖），跑完即删 */
const fs = require('fs');
const zlib = require('zlib');

/* ---------- 最小 PNG 编码器 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
              : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 在 2048 画布上绘制图标：鼠尾草绿底 + 奶白碗 + 热气 ---------- */
const S = 2048;
const px = new Uint8Array(S * S * 4);
const C = {
  bg:   [0x6f, 0x84, 0x57],  // 鼠尾草绿
  deep: [0x53, 0x65, 0x3f],  // 碗内深绿
  cream:[0xff, 0xfe, 0xfa],  // 奶白
};
const cy = 0.66, r = 0.24; // 碗心与半径

function set(x, y, c) {
  const i = (y * S + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
}
function stamp(cx, cy_, rad, c) { // 以画布坐标比例画实心圆
  const R = Math.max(1, Math.round(rad * S));
  const X = Math.round(cx * S), Y = Math.round(cy_ * S);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    if (dx * dx + dy * dy <= R * R) {
      const x = X + dx, y = Y + dy;
      if (x >= 0 && x < S && y >= 0 && y < S) set(x, y, c);
    }
  }
}
for (let y = 0; y < S; y++) {
  const v = (y + 0.5) / S;
  for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S;
    let c = C.bg;
    const inBowl = (u - 0.5) * (u - 0.5) + (v - cy) * (v - cy) <= r * r;      // 碗身（半圆）
    const foot = u >= 0.435 && u <= 0.565 && v >= cy + r - 0.015 && v <= cy + r + 0.048; // 碗脚
    const outer = ((u - 0.5) / 0.273) ** 2 + ((v - cy) / 0.041) ** 2 <= 1;     // 沿口外椭圆
    const inner = ((u - 0.5) / 0.236) ** 2 + ((v - cy + 0.003) / 0.024) ** 2 <= 1; // 沿口内椭圆
    if (foot) c = C.cream;
    else if (inBowl && v <= cy) c = C.cream;
    if (v <= cy && inner) c = C.deep;          // 碗内深色开口
    if (outer && !inner && v <= cy + 0.02) c = C.cream; // 奶白沿口环
    set(x, y, c);
  }
}
/* 两缕热气（波浪曲线，逐渐收细） */
for (const k of [-1, 1]) {
  const x0 = 0.5 + k * 0.085;
  for (let i = 0; i <= 260; i++) {
    const t = i / 260;
    const v = cy - 0.085 - 0.235 * t;
    const u = x0 + Math.sin(t * 2.7 * Math.PI + (k > 0 ? 0.5 : 1.6)) * 0.027;
    stamp(u, v, 0.0185 * (1 - 0.22 * t), C.cream);
  }
}

/* ---------- 区域平均降采样到目标尺寸并输出 ---------- */
function downscale(N) {
  const out = Buffer.alloc(N * N * 4);
  const f = S / N;
  const step = Math.max(1, Math.floor(f / 6));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let R = 0, G = 0, B = 0, n = 0;
    const sy0 = Math.floor(y * f), sy1 = Math.min(S, Math.floor((y + 1) * f));
    const sx0 = Math.floor(x * f), sx1 = Math.min(S, Math.floor((x + 1) * f));
    for (let sy = sy0; sy < sy1; sy += step) for (let sx = sx0; sx < sx1; sx += step) {
      const i = (sy * S + sx) * 4;
      R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
    }
    const o = (y * N + x) * 4;
    out[o] = R / n; out[o + 1] = G / n; out[o + 2] = B / n; out[o + 3] = 255;
  }
  return out;
}
for (const [name, size] of [['icon-512.png', 512], ['icon-192.png', 192], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(name, encodePNG(size, size, downsize(size)));
  console.log('wrote', name);
}
function downsize(n){ return Buffer.from(downscale(n)); }
