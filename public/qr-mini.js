/* Verified Self-Contained ISO/IEC 18004 QR Code SVG Generator (Byte Mode, ECC-L, Versions 1-12, Full 8-Mask ISO Penalty Scoring) */
(function () {
  "use strict";

  // [totalDataCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
  // Verified against ISO/IEC 18004:2015 Table 9 (ECC Level L)
  const V_SPEC = [
    null,
    [19, 7, 1, 19, 0, 0],     // V1:  26 total
    [34, 10, 1, 34, 0, 0],    // V2:  44 total
    [55, 15, 1, 55, 0, 0],    // V3:  70 total
    [80, 20, 1, 80, 0, 0],    // V4: 100 total
    [108, 26, 1, 108, 0, 0],  // V5: 134 total
    [136, 18, 2, 68, 0, 0],   // V6: 172 total
    [156, 20, 2, 78, 0, 0],   // V7: 196 total (2x78 data + 2x20 EC)
    [194, 24, 2, 97, 0, 0],   // V8: 242 total
    [232, 30, 2, 116, 0, 0],  // V9: 292 total
    [274, 18, 2, 68, 2, 69],  // V10: 346 total
    [324, 20, 4, 81, 0, 0],   // V11: 404 total
    [370, 24, 2, 92, 2, 93]   // V12: 466 total
  ];

  const MAX_VER = V_SPEC.length - 1;

  const ALIGN_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58]
  ];

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsDivisor(degree) {
    const result = new Uint8Array(degree);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsEncode(data, ecLen) {
    const div = rsDivisor(ecLen);
    const rem = new Uint8Array(ecLen);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[ecLen - 1] = 0;
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(div[j], factor);
      }
    }
    return rem;
  }

  function maskBit(mask, r, c) {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function drawFormatBits(modules, isFunc, size, mask) {
    // ECC Level L = 01 (1), mask = 0..7
    const data = (1 << 3) | (mask & 7);
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits15 = ((data << 10) | rem) ^ 0x5412;
    const getBit = (i) => ((bits15 >>> i) & 1) === 1;
    const setF = (r, c, dark) => {
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    };

    for (let i = 0; i <= 5; i++) setF(i, 8, getBit(i));
    setF(7, 8, getBit(6));
    setF(8, 8, getBit(7));
    setF(8, 7, getBit(8));
    for (let i = 9; i < 15; i++) setF(8, 14 - i, getBit(i));

    for (let i = 0; i < 8; i++) setF(8, size - 1 - i, getBit(i));
    for (let i = 8; i < 15; i++) setF(size - 15 + i, 8, getBit(i));
    setF(size - 8, 8, true);
  }

  function finderPenaltyLine(line, len) {
    // ISO/IEC 18004 §7.8.3.1 N3: 1:1:3:1:1 dark:light:dark:light:dark preceded or followed by 4 light modules
    let score = 0;
    for (let i = 0; i <= len - 11; i++) {
      const p1 =
        line[i] === 1 && line[i + 1] === 0 &&
        line[i + 2] === 1 && line[i + 3] === 1 && line[i + 4] === 1 &&
        line[i + 5] === 0 && line[i + 6] === 1 &&
        line[i + 7] === 0 && line[i + 8] === 0 && line[i + 9] === 0 && line[i + 10] === 0;
      const p2 =
        line[i] === 0 && line[i + 1] === 0 && line[i + 2] === 0 && line[i + 3] === 0 &&
        line[i + 4] === 1 && line[i + 5] === 0 &&
        line[i + 6] === 1 && line[i + 7] === 1 && line[i + 8] === 1 &&
        line[i + 9] === 0 && line[i + 10] === 1;
      if (p1 || p2) score += 40;
    }
    return score;
  }

  function computePenaltyScore(modules, size) {
    let score = 0;
    let darkCount = 0;
    const colBuf = new Uint8Array(size);

    // N1 (row runs >= 5) + N3 (row finder-like patterns) + dark count
    for (let r = 0; r < size; r++) {
      const row = modules[r];
      let runColor = row[0];
      let runLen = 1;
      darkCount += row[0];
      for (let c = 1; c < size; c++) {
        const v = row[c];
        darkCount += v;
        if (v === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = v;
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
      score += finderPenaltyLine(row, size);
    }

    // N1 (col runs >= 5) + N3 (col finder-like patterns)
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size; r++) colBuf[r] = modules[r][c];
      let runColor = colBuf[0];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        const v = colBuf[r];
        if (v === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = v;
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
      score += finderPenaltyLine(colBuf, size);
    }

    // N2 (2x2 homogeneous blocks)
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    // N4 (dark/light balance)
    const total = size * size;
    const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
    if (k > 0) score += k * 10;

    return score;
  }

  function encodeQRMatrix(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let ver = 1;
    while (ver <= MAX_VER) {
      const capBits = V_SPEC[ver][0] * 8;
      const lenBits = ver <= 9 ? 8 : 16;
      if (4 + lenBits + bytes.length * 8 <= capBits) break;
      ver++;
    }
    if (ver > MAX_VER) {
      throw new RangeError(
        "QR payload length (" + bytes.length + " bytes) exceeds Version " + MAX_VER + " capacity"
      );
    }

    const spec = V_SPEC[ver];
    const totalDataBytes = spec[0];
    const lenBits = ver <= 9 ? 8 : 16;

    const bits = [];
    const pushBits = (val, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    pushBits(0b0100, 4);
    pushBits(bytes.length, lenBits);
    for (let i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);

    const maxDataBits = totalDataBytes * 8;
    pushBits(0, Math.min(4, maxDataBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = new Uint8Array(totalDataBytes);
    for (let i = 0; i < bits.length / 8; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      dataCodewords[i] = b;
    }
    for (let i = bits.length / 8, p = 0; i < totalDataBytes; i++, p++) {
      dataCodewords[i] = p % 2 === 0 ? 0xec : 0x11;
    }

    const ecLen = spec[1];
    const blocks = [], ecBlocks = [];
    let offset = 0;
    for (let b = 0; b < spec[2]; b++) {
      const slice = dataCodewords.slice(offset, offset + spec[3]);
      offset += spec[3];
      blocks.push(slice);
      ecBlocks.push(rsEncode(slice, ecLen));
    }
    for (let b = 0; b < spec[4]; b++) {
      const slice = dataCodewords.slice(offset, offset + spec[5]);
      offset += spec[5];
      blocks.push(slice);
      ecBlocks.push(rsEncode(slice, ecLen));
    }

    const interleaved = [];
    const maxBlockLen = Math.max(spec[3], spec[5]);
    for (let i = 0; i < maxBlockLen; i++) {
      for (let b = 0; b < blocks.length; b++) {
        if (i < blocks[b].length) interleaved.push(blocks[b][i]);
      }
    }
    for (let i = 0; i < ecLen; i++) {
      for (let b = 0; b < ecBlocks.length; b++) {
        interleaved.push(ecBlocks[b][i]);
      }
    }

    const size = ver * 4 + 17;
    const baseModules = Array.from({ length: size }, () => new Uint8Array(size));
    const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

    function setFunc(r, c, dark) {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      baseModules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }

    function drawFinder(r, c) {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const inOuter = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const inRing = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          setFunc(r + dy, c + dx, inOuter && (inRing || inCore));
        }
      }
    }
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    const aligns = ALIGN_POS[ver];
    for (let i = 0; i < aligns.length; i++) {
      for (let j = 0; j < aligns.length; j++) {
        if (
          (i === 0 && j === 0) ||
          (i === 0 && j === aligns.length - 1) ||
          (i === aligns.length - 1 && j === 0)
        ) {
          continue;
        }
        const cr = aligns[i], cc = aligns[j];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            setFunc(cr + dy, cc + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        isFunc[8][i] = 1;
        isFunc[i][8] = 1;
      }
    }
    for (let i = 0; i < 8; i++) {
      isFunc[size - 1 - i][8] = 1;
      isFunc[8][size - 1 - i] = 1;
    }
    setFunc(size - 8, 8, true);

    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vBits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((vBits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    // Place unmasked data & EC bits
    let bitIdx = 0;
    const totalBits = interleaved.length * 8;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!isFunc[r][c]) {
            let dark = false;
            if (bitIdx < totalBits) {
              dark = ((interleaved[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
              bitIdx++;
            }
            baseModules[r][c] = dark ? 1 : 0;
          }
        }
      }
      upward = !upward;
    }

    // Evaluate all 8 masks (0..7) and select lowest ISO penalty
    let bestMask = 0;
    let bestPenalty = Infinity;
    let bestModules = null;

    for (let mask = 0; mask < 8; mask++) {
      const candidate = baseModules.map((row) => new Uint8Array(row));
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!isFunc[r][c] && maskBit(mask, r, c)) {
            candidate[r][c] ^= 1;
          }
        }
      }
      drawFormatBits(candidate, isFunc, size, mask);
      const pen = computePenaltyScore(candidate, size);
      if (pen < bestPenalty) {
        bestPenalty = pen;
        bestMask = mask;
        bestModules = candidate;
      }
    }

    return { version: ver, mask: bestMask, size, modules: bestModules };
  }

  function renderQRSVG(text, opts) {
    const options = opts || {};
    const colorRe = /^(#[0-9A-Fa-f]{3,8}|currentColor|transparent|var\(--red\))$/;
    const fg = colorRe.test(String(options.fg || "")) ? options.fg : "#000000";
    const bg = colorRe.test(String(options.bg || "")) ? options.bg : "var(--red)";
    const margin = typeof options.margin === "number" && options.margin >= 4 ? options.margin : 4;
    const { size, modules } = encodeQRMatrix(text);
    const total = size + margin * 2;
    let path = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) path += "M" + (c + margin) + "," + (r + margin) + "h1v1h-1z";
      }
    }
    return (
      "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + total + " " + total +
      "\" shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"Scan QR code with your phone camera to count steps\">" +
      "<rect width=\"" + total + "\" height=\"" + total + "\" fill=\"" + bg + "\"/>" +
      "<path d=\"" + path + "\" fill=\"" + fg + "\"/>" +
      "</svg>"
    );
  }

  if (typeof window !== "undefined") window.RuntimeQR = { renderQRSVG, encodeQRMatrix };
  if (typeof module !== "undefined" && module.exports) module.exports = { renderQRSVG, encodeQRMatrix };
})();
