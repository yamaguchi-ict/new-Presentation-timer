/*!
 * qr-encode.js — 最小構成のQRコード生成器（byte mode, EC level M）
 * 依存なし。URLのような短いASCII/UTF-8文字列を QR バージョン1〜10 で生成する。
 * 参考仕様: ISO/IEC 18004
 */
(function (root) {
  "use strict";

  /* ---------- GF(256) ---------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  /* ---------- RS 生成多項式 ---------- */
  var GEN_CACHE = {};
  function rsGen(deg) {
    if (EXP[0] && GENERATORS[deg]) return GENERATORS[deg];
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], 1);
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    GENERATORS[deg] = poly;
    return poly;
  }
  var GENERATORS = {};

  function rsEncode(data, ecLen) {
    var gen = rsGen(ecLen);
    var res = new Uint8Array(ecLen);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.copyWithin(0, 1);
      res[ecLen - 1] = 0;
      if (factor !== 0) {
        for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
      }
    }
    return res;
  }

  /* ---------- バージョン/誤り訂正テーブル（ECレベル M） ---------- */
  // [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCW, group2Blocks, group2DataCW]
  var TABLE_M = {
    1: [26, 10, 1, 16, 0, 0],
    2: [44, 16, 1, 28, 0, 0],
    3: [70, 26, 1, 44, 0, 0],
    4: [100, 18, 2, 32, 0, 0],
    5: [134, 24, 2, 43, 0, 0],
    6: [172, 16, 4, 27, 0, 0],
    7: [196, 18, 4, 31, 0, 0],
    8: [242, 22, 2, 38, 2, 39],
    9: [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
    11: [404, 30, 1, 50, 4, 51],
    12: [466, 22, 6, 36, 2, 37],
    13: [532, 22, 8, 37, 1, 38],
    14: [581, 24, 4, 40, 5, 41],
    15: [655, 24, 5, 41, 5, 42]
  };
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
    10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
    13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70]
  };

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function chooseVersion(len) {
    for (var v = 1; v <= 15; v++) {
      var t = TABLE_M[v];
      var dataCW = t[2] * t[3] + t[4] * t[5];
      var header = 4 + (v < 10 ? 8 : 16);
      if (dataCW * 8 >= header + len * 8) return v;
    }
    return -1;
  }

  /* ---------- ビット列 ---------- */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (num, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((num >>> i) & 1);
  };

  function buildData(bytes, version) {
    var t = TABLE_M[version];
    var dataCW = t[2] * t[3] + t[4] * t[5];
    var bb = new BitBuffer();
    bb.put(4, 4);                                   // byte mode
    bb.put(bytes.length, version < 10 ? 8 : 16);    // 文字数
    for (var i = 0; i < bytes.length; i++) bb.put(bytes[i], 8);

    // 終端
    var cap = dataCW * 8;
    var term = Math.min(4, cap - bb.bits.length);
    bb.put(0, term);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    var codewords = [];
    for (var k = 0; k < bb.bits.length; k += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[k + j];
      codewords.push(b);
    }
    var pad = [0xec, 0x11], pi = 0;
    while (codewords.length < dataCW) { codewords.push(pad[pi++ % 2]); }
    return codewords;
  }

  /* ---------- ブロック分割＋EC ---------- */
  function interleave(codewords, version) {
    var t = TABLE_M[version];
    var ecLen = t[1], g1 = t[2], d1 = t[3], g2 = t[4], d2 = t[5];
    var blocks = [], pos = 0, i;
    for (i = 0; i < g1; i++) { blocks.push(codewords.slice(pos, pos + d1)); pos += d1; }
    for (i = 0; i < g2; i++) { blocks.push(codewords.slice(pos, pos + d2)); pos += d2; }
    var ecs = blocks.map(function (b) { return Array.from(rsEncode(Uint8Array.from(b), ecLen)); });

    var out = [], maxD = Math.max(d1, d2);
    for (i = 0; i < maxD; i++) {
      for (var b = 0; b < blocks.length; b++) {
        if (blocks[b][i] !== undefined) out.push(blocks[b][i]);
      }
    }
    for (i = 0; i < ecLen; i++) {
      for (var c = 0; c < blocks.length; c++) out.push(ecs[c][i]);
    }
    return out;
  }

  /* ---------- 行列 ---------- */
  function Matrix(version) {
    this.v = version;
    var size = version * 4 + 17;
    this.size = size;
    this.m = [];
    this.fn = [];
    for (var y = 0; y < size; y++) {
      this.m.push(new Uint8Array(size));
      this.fn.push(new Uint8Array(size));
    }
  }
  Matrix.prototype.setF = function (x, y, v) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.m[y][x] = v; this.fn[y][x] = 1;
  };

  function placeFinder(M, cx, cy) {
    for (var dy = -1; dy <= 7; dy++) {
      for (var dx = -1; dx <= 7; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= M.size || y >= M.size) continue;
        var on = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) &&
                 (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        M.setF(x, y, on ? 1 : 0);
      }
    }
  }

  function placeAlignment(M) {
    var pos = ALIGN[M.v];
    for (var i = 0; i < pos.length; i++) {
      for (var j = 0; j < pos.length; j++) {
        var cx = pos[i], cy = pos[j];
        if ((cx <= 8 && cy <= 8) || (cx <= 8 && cy >= M.size - 9) || (cx >= M.size - 9 && cy <= 8)) continue;
        for (var dy = -2; dy <= 2; dy++) {
          for (var dx = -2; dx <= 2; dx++) {
            var on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
            M.setF(cx + dx, cy + dy, on ? 1 : 0);
          }
        }
      }
    }
  }

  function placeTiming(M) {
    for (var i = 8; i < M.size - 8; i++) {
      M.setF(i, 6, i % 2 === 0 ? 1 : 0);
      M.setF(6, i, i % 2 === 0 ? 1 : 0);
    }
  }

  function reserve(M) {
    var i;
    for (i = 0; i < 9; i++) {
      if (!M.fn[8][i]) M.setF(i, 8, 0);
      if (!M.fn[i][8]) M.setF(8, i, 0);
    }
    for (i = 0; i < 8; i++) {
      M.setF(M.size - 1 - i, 8, 0);
      M.setF(8, M.size - 1 - i, 0);
    }
    M.setF(8, M.size - 8, 1); // dark module
    if (M.v >= 7) {
      for (i = 0; i < 6; i++) {
        for (var j = 0; j < 3; j++) {
          M.setF(M.size - 11 + j, i, 0);
          M.setF(i, M.size - 11 + j, 0);
        }
      }
    }
  }

  function placeData(M, codewords) {
    var size = M.size, bitIdx = 0;
    var total = codewords.length * 8;
    for (var right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;
      var upward = ((right + 1) & 2) === 0;
      for (var vert = 0; vert < size; vert++) {
        var y = upward ? size - 1 - vert : vert;
        for (var k = 0; k < 2; k++) {
          var x = right - k;
          if (M.fn[y][x]) continue;
          var bit = 0;
          if (bitIdx < total) {
            bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          M.m[y][x] = bit;
        }
      }
    }
  }

  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x, y) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; },
    function (x, y) { return ((x * y) % 2) + ((x * y) % 3) === 0; },
    function (x, y) { return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; },
    function (x, y) { return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; }
  ];

  function applyMask(M, maskId) {
    var f = MASKS[maskId];
    for (var y = 0; y < M.size; y++) {
      for (var x = 0; x < M.size; x++) {
        if (!M.fn[y][x] && f(x, y)) M.m[y][x] ^= 1;
      }
    }
  }

  /* ---------- 形式情報 / バージョン情報 ---------- */
  function bch15(data5) {
    var d = data5 << 10;
    for (var i = 4; i >= 0; i--) {
      if (d & (1 << (i + 10))) d ^= 0x537 << i;
    }
    return ((data5 << 10) | d) ^ 0x5412;
  }
  function bch18(ver) {
    var d = ver << 12;
    for (var i = 5; i >= 0; i--) {
      if (d & (1 << (i + 12))) d ^= 0x1f25 << i;
    }
    return (ver << 12) | d;
  }

  function placeFormat(M, maskId) {
    var bits = bch15((0 << 3) | maskId); // ECレベルM = 0b00
    var size = M.size;
    for (var i = 0; i < 15; i++) {
      var bit = (bits >> i) & 1;
      // 左上
      if (i < 6) M.setF(8, i, bit);
      else if (i === 6) M.setF(8, 7, bit);
      else if (i === 7) M.setF(8, 8, bit);
      else if (i === 8) M.setF(7, 8, bit);
      else M.setF(14 - i, 8, bit);
      // 右上/左下
      if (i < 8) M.setF(size - 1 - i, 8, bit);
      else M.setF(8, size - 15 + i, bit);
    }
    M.setF(8, size - 8, 1);
  }

  function placeVersion(M) {
    if (M.v < 7) return;
    var bits = bch18(M.v);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >> i) & 1;
      var a = M.size - 11 + (i % 3);
      var b = Math.floor(i / 3);
      M.setF(a, b, bit);
      M.setF(b, a, bit);
    }
  }

  /* ---------- マスク評価 ---------- */
  function penalty(M) {
    var size = M.size, score = 0, x, y, run, dark = 0;

    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (M.m[y][x] === M.m[y][x - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (M.m[y][x] === M.m[y - 1][x]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; }
        else run = 1;
      }
    }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = M.m[y][x];
        if (v === M.m[y][x + 1] && v === M.m[y + 1][x] && v === M.m[y + 1][x + 1]) score += 3;
      }
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x < size - 6; x++) {
        if (M.m[y][x] && !M.m[y][x + 1] && M.m[y][x + 2] && M.m[y][x + 3] && M.m[y][x + 4] && !M.m[y][x + 5] && M.m[y][x + 6]) score += 40;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y < size - 6; y++) {
        if (M.m[y][x] && !M.m[y + 1][x] && M.m[y + 2][x] && M.m[y + 3][x] && M.m[y + 4][x] && !M.m[y + 5][x] && M.m[y + 6][x]) score += 40;
      }
    }
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (M.m[y][x]) dark++;
    var ratio = Math.abs(dark * 100 / (size * size) - 50) / 5;
    score += Math.floor(ratio) * 10;

    return score;
  }

  /* ---------- 公開API ---------- */
  function encode(text) {
    var bytes = utf8Bytes(String(text));
    var version = chooseVersion(bytes.length);
    if (version < 0) throw new Error("QR: 文字列が長すぎます");

    var data = buildData(bytes, version);
    var cw = interleave(data, version);

    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mask = 0; mask < 8; mask++) {
      var M = new Matrix(version);
      placeFinder(M, 0, 0);
      placeFinder(M, M.size - 7, 0);
      placeFinder(M, 0, M.size - 7);
      placeAlignment(M);
      placeTiming(M);
      reserve(M);
      placeVersion(M);
      placeData(M, cw);
      applyMask(M, mask);
      placeFormat(M, mask);
      var p = penalty(M);
      if (p < bestScore) { bestScore = p; best = M; bestMask = mask; }
    }
    return {
      size: best.size,
      version: version,
      mask: bestMask,
      modules: best.m
    };
  }

  root.QR = { encode: encode };
})(typeof window !== "undefined" ? window : globalThis);
