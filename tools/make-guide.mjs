/* THE OUTLINE BEHIND THE PRESET - Babe, 2026-10-29, after Krea came back with a
 * bear BUST: "or on the back-end for that model we just feed it something else
 * like an outline of a portrait", "like a guide".
 *
 * `GUIDE_SYS` ALREADY FORBIDS RETURNING A BUST and the picture won anyway,
 * which is this rail's own lesson twice over - 02's sheet forbids a gutter and
 * the model draws the one it was shown, 04's board forbids the labels and the
 * model letters them. A model handed a shape copies the shape, and an edit
 * checkpoint that holds structure hard copies it hardest. So the thing to
 * change is not the sentence, it is the picture: the mannequin stays as what a
 * person SEES in the slot, and this is what goes to Comfy behind it.
 *
 * AN OUTLINE HAS NOTHING TO LOCK ONTO. No plinth, no carved shoulders, no
 * material, no light - the only thing it carries is the one thing the guide is
 * FOR: the crop, the camera distance, the eye level and how much of the frame
 * the head fills. Everything `GUIDE_SYS` says to take, and nothing it says to
 * refuse.
 *
 * IT IS DRAWN RATHER THAN GENERATED, which is also why it is a script and not a
 * file somebody made once: a line drawing is a pure function of a few numbers,
 * the numbers are the framing, and changing the framing is editing them here.
 * Pure Node - a grayscale PNG is a zlib stream with a one-byte filter per row.
 *
 * `node tools/make-guide.mjs` writes bg/preset-outline.png. */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const N = 1024;
const INK = 0;      /* the ground, which matches the preset's own dark plate */
const LINE = 210;   /* the drawing, bright enough to read as the subject */

/* THE FRAMING, IN FRACTIONS OF THE FRAME, read off the preset bust so the two
 * agree about where a head sits: centred, eyes a little above the middle of the
 * upper half, and shoulders that leave the frame rather than ending in air. */
const HEAD = { x: 0.500, y: 0.360, rx: 0.138, ry: 0.178 };
const NECK = 0.055;                 /* half-width of the neck */
const JAW  = HEAD.y + HEAD.ry * 0.86;
const SHOULDER = { y: 0.760, out: 0.165 };  /* where the line turns and how far past the frame it runs */
const W = 4.2;                      /* stroke, in pixels */

const img = new Uint8Array(N * N).fill(INK);

/* one stamp, with a soft edge so a curve does not read as stairs */
function dot(px, py) {
  const r = W / 2, r2 = r + 1;
  const x0 = Math.max(0, Math.floor(px - r2)), x1 = Math.min(N - 1, Math.ceil(px + r2));
  const y0 = Math.max(0, Math.floor(py - r2)), y1 = Math.min(N - 1, Math.ceil(py + r2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
      if (d > r2) continue;
      const a = d <= r - 0.5 ? 1 : Math.max(0, Math.min(1, (r + 0.5 - d)));
      const at = y * N + x;
      const v = Math.round(INK + (LINE - INK) * a);
      if (v > img[at]) img[at] = v;
    }
  }
}

/* curves are sampled rather than solved: dense enough and the stamps join */
const line = (ax, ay, bx, by) => {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) * N / 1.5);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    dot((ax + (bx - ax) * t) * N, (ay + (by - ay) * t) * N);
  }
};
const curve = (ax, ay, cx, cy, bx, by) => {
  const n = Math.ceil((Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy)) * N / 1.5);
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    dot((u * u * ax + 2 * u * t * cx + t * t * bx) * N,
        (u * u * ay + 2 * u * t * cy + t * t * by) * N);
  }
};

/* the head */
for (let i = 0; i <= 2400; i++) {
  const a = (i / 2400) * Math.PI * 2;
  dot((HEAD.x + Math.cos(a) * HEAD.rx) * N, (HEAD.y + Math.sin(a) * HEAD.ry) * N);
}

/* the neck, from the jaw down to where the shoulders take over */
line(HEAD.x - NECK, JAW, HEAD.x - NECK * 1.02, SHOULDER.y - 0.085);
line(HEAD.x + NECK, JAW, HEAD.x + NECK * 1.02, SHOULDER.y - 0.085);

/* the shoulders, each turning once and then running off the bottom edge, so
   nothing in the drawing ends in mid-air the way a carved bust does */
for (const s of [-1, 1]) {
  curve(HEAD.x + s * NECK * 1.02, SHOULDER.y - 0.085,
        HEAD.x + s * 0.165, SHOULDER.y - 0.015,
        HEAD.x + s * (0.5 + SHOULDER.out) * 0.62, SHOULDER.y + 0.085);
  line(HEAD.x + s * (0.5 + SHOULDER.out) * 0.62, SHOULDER.y + 0.085,
       HEAD.x + s * (0.5 + SHOULDER.out) * 0.80, 1.02);
}

/* -------------------------------------------------- a grayscale PNG by hand */

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8;   /* bit depth */
ihdr[9] = 0;   /* colour type 0: grayscale */

const raw = Buffer.alloc((N + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N + 1)] = 0;                      /* filter: none */
  raw.set(img.subarray(y * N, y * N + N), y * (N + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(fileURLToPath(new URL('..', import.meta.url)), 'bg', 'preset-outline.png');
writeFileSync(out, png);
console.log(`  ${N}x${N} grayscale, ${(png.length / 1024).toFixed(1)}KB  ->  ${out}`);
