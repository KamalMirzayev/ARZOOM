// Yüklənən faylın həqiqətən PDF və ya şəkil olduğunu ilk baytlarından yoxlayır (brauzerin dediyi tipə güvənmirik).
const fs = require("fs");
const SIGS = [
  ["application/pdf", b => b.subarray(0, 5).toString("latin1") === "%PDF-"],
  ["image/png", b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", b => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
  ["image/heic", b => b.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(b.subarray(8, 12).toString("latin1"))]
];
function sniff(file) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); return SIGS.find(([, t]) => t(b))?.[0] || null; }
  finally { fs.closeSync(fd); }
}
module.exports = { sniff };
