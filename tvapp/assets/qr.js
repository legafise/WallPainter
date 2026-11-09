// Minimal QR Code generator (byte mode, error correction level M), plain ES5.
// Follows ISO/IEC 18004 the same way as Project Nayuki's reference implementation.
// QR.make(text) -> { size, get(x, y) -> true for dark }
var QR = (function () {
  // level M tables, index = version (1..40)
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  var ECL_FORMAT_BITS = 0; // M

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver) { return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver]; }

  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ res.shift();
      res.push(0);
      for (var i = 0; i < div.length; i++) res[i] ^= gfMul(div[i], factor);
    }
    return res;
  }

  function utf8(s) {
    var out = [], e = unescape(encodeURIComponent(s));
    for (var i = 0; i < e.length; i++) out.push(e.charCodeAt(i));
    return out;
  }

  function make(text) {
    var bytes = utf8(text), ver, cap;
    for (ver = 1; ver <= 40; ver++) {
      var ccBits = ver < 10 ? 8 : 16;
      cap = dataCodewords(ver) * 8;
      if (4 + ccBits + bytes.length * 8 <= cap) break;
    }
    if (ver > 40) throw new Error('text too long for QR');

    // ---- bit stream
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) put(bytes[i], 8);
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }

    // ---- error correction + interleave
    var numBlocks = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
    var rawCw = Math.floor(rawModules(ver) / 8);
    var numShort = numBlocks - rawCw % numBlocks, shortLen = Math.floor(rawCw / numBlocks);
    var div = rsDivisor(eccLen), blocks = [], k = 0;
    for (i = 0; i < numBlocks; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var cw = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (j = 0; j < blocks.length; j++) {
        if (i !== shortLen - eccLen || j >= numShort) cw.push(blocks[j][i]);
      }
    }

    // ---- matrix
    var size = ver * 4 + 17, mod = [], fn = [];
    for (i = 0; i < size; i++) { mod.push([]); fn.push([]); for (j = 0; j < size; j++) { mod[i].push(false); fn[i].push(false); } }
    function setF(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }

    for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    function finder(x, y) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setF(xx, yy, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    var align = [];
    if (ver > 1) {
      var na = Math.floor(ver / 7) + 2;
      var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
      align = [6];
      for (var pos = size - 7; align.length < na; pos -= step) align.splice(1, 0, pos);
    }
    for (i = 0; i < align.length; i++) for (j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++)
        setF(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    function drawFormat(mask) {
      var d = (ECL_FORMAT_BITS << 3) | mask, rem = d;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fb = ((d << 10) | rem) ^ 0x5412;
      function bit(i) { return ((fb >>> i) & 1) !== 0; }
      for (i = 0; i <= 5; i++) setF(8, i, bit(i));
      setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
      for (i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
      for (i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
      for (i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
      setF(8, size - 8, true);
    }
    drawFormat(0); // reserve

    if (ver >= 7) {
      var rem = ver;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vb = (ver << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bt = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, c = Math.floor(i / 3);
        setF(a, c, bt); setF(c, a, bt);
      }
    }

    // codewords in zigzag order
    var bi = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < cw.length * 8) {
          mod[y][x] = ((cw[bi >>> 3] >>> (7 - (bi & 7))) & 1) !== 0;
          bi++;
        }
      }
    }

    function maskBit(m, x, y) {
      switch (m) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return x * y % 2 + x * y % 3 === 0;
        case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
        default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
      }
    }
    function applyMask(m) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++)
        if (!fn[y][x] && maskBit(m, x, y)) mod[y][x] = !mod[y][x];
    }
    // simplified penalty (runs, 2x2 blocks, balance) to pick a good mask
    function penalty() {
      var p = 0, dark = 0, x, y, run, prev;
      for (y = 0; y < size; y++) {
        run = 0; prev = null;
        for (x = 0; x < size; x++) {
          if (mod[y][x] === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { prev = mod[y][x]; run = 1; }
          if (mod[y][x]) dark++;
        }
      }
      for (x = 0; x < size; x++) {
        run = 0; prev = null;
        for (y = 0; y < size; y++) {
          if (mod[y][x] === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { prev = mod[y][x]; run = 1; }
        }
      }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
        var cc = mod[y][x];
        if (cc === mod[y][x + 1] && cc === mod[y + 1][x] && cc === mod[y + 1][x + 1]) p += 3;
      }
      var total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    }
    var best = 0, bestP = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      var pp = penalty();
      if (pp < bestP) { bestP = pp; best = m; }
      applyMask(m); // undo
    }
    applyMask(best); drawFormat(best);

    return { size: size, version: ver, mask: best, get: function (x, y) { return mod[y][x]; } };
  }

  // Draw onto a canvas: dark modules black on a white square with a quiet zone.
  function draw(canvas, text, px) {
    var q = make(text), quiet = 4, n = q.size + quiet * 2;
    var scale = Math.max(1, Math.floor(px / n));
    canvas.width = canvas.height = n * scale;
    var g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#000';
    for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++)
      if (q.get(x, y)) g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    return q;
  }

  return { make: make, draw: draw };
})();
if (typeof module !== 'undefined') module.exports = QR;
