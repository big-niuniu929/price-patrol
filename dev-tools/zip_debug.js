// xlsx zip 结构调试
const fs = require('fs');
const path = process.argv[2] || '~/Desktop/SKU巡检表.xlsx';
const buf = fs.readFileSync(path);
const u8 = new Uint8Array(buf);
const u16 = (o) => u8[o] | (u8[o + 1] << 8);
const u32 = (o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
let eocd = -1;
for (let i = u8.length - 22; i >= 0; i--) {
  if (u32(i) === 0x06054b50) { eocd = i; break; }
}
console.log('size', u8.length, 'eocd', eocd, 'hex', eocd >= 0 ? u8.slice(eocd, eocd + 22).toString('hex') : null);
if (eocd >= 0) {
  console.log('count', u16(eocd + 10), 'cdOffset', u32(eocd + 16), 'cdSize', u32(eocd + 12));
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < Math.min(count, 8); i++) {
    console.log('entry sig', u32(p).toString(16), 'method', u16(p + 10), 'comp', u32(p + 20), 'nameLen', u16(p + 28), 'local', u32(p + 42));
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + u16(p + 28)));
    const local = u32(p + 42);
    console.log('  name', name, 'localSig', u32(local).toString(16));
    p += 46 + u16(p + 28) + u16(p + 30) + u16(p + 32);
  }
}
console.log('tail hex', u8.slice(u8.length - 32).toString('hex'));
