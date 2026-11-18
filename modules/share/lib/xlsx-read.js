/**
 * lib/xlsx-read.js —— 零依赖 xlsx 读取（浏览器/Node 通用）
 *
 * 自己实现：
 *   - ZIP 解包（解析 EOCD/中央目录/local header，deflate-raw 用原生 DecompressionStream）；
 *   - OOXML 解析（workbook.xml + rels + sharedStrings.xml + sheet*.xml，简单 XML 词法解析）。
 *
 * 关键点（对应旧工具实测坑）：
 *   - 完全不信任 <dimension>（真实榜单文件里写成 A1，实际 201×13），一律按 <row>/<c> 的 r 属性解析；
 *   - 兼容 inlineStr / t="s" / t="str" / 数字 / 布尔 / 错误值；公式取缓存值 <v>；
 *   - 空单元格补 null，行/列按实际出现位置对齐。
 *
 * 契约（DESIGN.md 第 10 节）：readXlsx(input:ArrayBuffer|Uint8Array|Blob|File)
 *   -> Promise<{ sheets: [{ name, rows: Array<Array<string|null>> }] }>
 */

const utf8Decoder = new TextDecoder('utf-8');

/** 把入参统一成字节数组 */
async function toBytes(input) {
  if (input == null) throw new Error('读取 xlsx 失败：文件内容为空');
  if (typeof input === 'string') {
    throw new Error('读取 xlsx 失败：请传文件内容（ArrayBuffer/Uint8Array/Blob/File），不要传文件路径');
  }
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input && typeof input.arrayBuffer === 'function') {
    return new Uint8Array(await input.arrayBuffer());
  }
  throw new Error('读取 xlsx 失败：不支持的文件类型（需要 ArrayBuffer / Uint8Array / Blob / File）');
}

/** 在字节里从尾部找 EOCD（0x06054b50） */
function findEndOfCentralDirectory(bytes) {
  const minOffset = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return i;
    }
  }
  return -1;
}

/** 读小端 u16 / u32 */
function readU16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes, offset) {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

/** 用原生 DecompressionStream 解 deflate-raw（Blob.stream + pipeThrough 并发读写，避免大文件背压死锁） */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 DecompressionStream，无法解压 xlsx（请用较新的 Edge/Chrome 或 Node 18+）');
  }
  const source = new Blob([bytes]).stream();
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * 解析 ZIP 中央目录，返回 name -> {method, compressedSize, dataStart}。
 * 只支持普通 ZIP（xlsx 都是），遇到 ZIP64 直接给出人话错误。
 */
function readZipDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    throw new Error('不是有效的 xlsx 文件（缺少 ZIP 结构，可能文件损坏或其实是 .xls 改后缀）');
  }
  const totalEntries = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 xlsx（文件过大）');
  }
  const entries = new Map();
  let offset = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) break;
    const flags = readU16(bytes, offset + 8);
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = utf8Decoder.decode(nameBytes);
    // 本地文件头里的文件名/额外字段长度可能与中央目录不同，以本地头为准
    if (readU32(bytes, localOffset) === 0x04034b50) {
      const localNameLength = readU16(bytes, localOffset + 26);
      const localExtraLength = readU16(bytes, localOffset + 28);
      entries.set(name.replace(/\\/g, '/').toLowerCase(), {
        name,
        method,
        flags,
        compressedSize,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
      });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.size) throw new Error('不是有效的 xlsx 文件（ZIP 目录为空）');
  return entries;
}

/** 取出某个 ZIP 条目的字节（必要时解压） */
async function readEntry(bytes, entries, name) {
  const key = String(name).replace(/\\/g, '/').toLowerCase();
  const entry = entries.get(key);
  if (!entry) return null;
  const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed);
  throw new Error(`不支持的 ZIP 压缩方式：${entry.method}（${entry.name}）`);
}

/** 取出并解码 XML 文本 */
async function readXmlEntry(bytes, entries, name) {
  const data = await readEntry(bytes, entries, name);
  if (!data) return null;
  return utf8Decoder.decode(data);
}

/** 解析标签属性：attr="value" 或 attr='value' */
function parseAttributes(text) {
  const attributes = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    attributes[match[1]] = match[2] != null ? match[2] : match[3];
  }
  return attributes;
}

/** XML 文本反转义（先数字实体，再命名实体，&amp; 最后） */
function decodeXml(text) {
  if (!text || text.indexOf('&') < 0) return text || '';
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 取一段 XML（如 <is> 或 <si>）里的全部 <t> 文本（跳过日文注音 <rPh>） */
function extractTextRuns(innerXml) {
  const withoutPhonetic = innerXml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const parts = [];
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let match;
  while ((match = re.exec(withoutPhonetic)) !== null) {
    if (match[1]) parts.push(decodeXml(match[1]));
  }
  return parts.join('');
}

/** 单元格引用（如 "AB12"）→ { column: 2, row: 12 }（column 为 1-based） */
function parseCellReference(ref) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(ref || '').trim());
  if (!match) return null;
  const letters = match[1].toUpperCase();
  let column = 0;
  for (let i = 0; i < letters.length; i += 1) {
    column = column * 26 + (letters.charCodeAt(i) - 64);
  }
  return { column, row: Number(match[2]) };
}

/** 数字单元格：保持原始文本（避免 1.0 变 1 影响显示；SKU 等大整数不丢精度） */
function normalizeNumberText(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  return text;
}

/** 解析单个单元格的值 */
function parseCellValue(attributes, innerXml, sharedStrings) {
  const type = attributes.t || 'n';
  if (type === 'inlineStr') {
    const isMatch = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(innerXml);
    if (!isMatch) return '';
    return extractTextRuns(isMatch[1]);
  }
  const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(innerXml);
  if (!vMatch) return null;
  const raw = decodeXml(vMatch[1]);
  if (type === 's') {
    const index = parseInt(raw, 10);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) return '';
    return sharedStrings[index];
  }
  if (type === 'b') return raw.trim() === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str') return raw;
  if (type === 'e') return raw || '#ERROR';
  if (type === 'd') return raw;
  return normalizeNumberText(raw);
}

/** 解析 sharedStrings.xml → 字符串数组 */
function parseSharedStrings(xml) {
  const strings = [];
  if (!xml) return strings;
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    strings.push(match[1] ? extractTextRuns(match[1]) : '');
  }
  return strings;
}

/** 解析 worksheet XML → 二维数组（空单元格补 null） */
function parseWorksheet(xml, sharedStrings) {
  const rowsByIndex = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowAttributes = parseAttributes(rowMatch[1]);
    const rowNumber = rowAttributes.r ? Number(rowAttributes.r) : rowsByIndex.length + 1;
    if (!Number.isInteger(rowNumber) || rowNumber <= 0) continue;
    const rowContent = rowMatch[2] || '';
    const cells = [];
    let nextColumnIndex = 0;
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowContent)) !== null) {
      const cellAttributes = parseAttributes(cellMatch[1]);
      let columnIndex = nextColumnIndex;
      const reference = cellAttributes.r ? parseCellReference(cellAttributes.r) : null;
      if (reference) columnIndex = reference.column - 1;
      if (columnIndex < 0) columnIndex = 0;
      nextColumnIndex = columnIndex + 1;
      const value = parseCellValue(cellAttributes, cellMatch[2] || '', sharedStrings);
      cells[columnIndex] = value;
    }
    // 稀疏数组补 null
    const normalized = [];
    for (let i = 0; i < cells.length; i += 1) {
      normalized.push(cells[i] === undefined ? null : cells[i]);
    }
    rowsByIndex[rowNumber - 1] = normalized;
  }
  const rows = [];
  for (let i = 0; i < rowsByIndex.length; i += 1) {
    rows.push(rowsByIndex[i] || []);
  }
  return rows;
}

/** 解析 workbook.xml.rels → Map<rId, target> */
function parseRelationships(xml) {
  const relations = new Map();
  if (!xml) return relations;
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (attributes.Id && attributes.Target) {
      relations.set(attributes.Id, {
        target: attributes.Target,
        type: attributes.Type || '',
      });
    }
  }
  return relations;
}

/** 解析相对路径：base 形如 'xl/'，target 可能是 'worksheets/sheet1.xml' 或 '/xl/workbook.xml' */
function resolvePath(base, target) {
  const path = String(target || '').replace(/\\/g, '/');
  if (!path) return '';
  const combined = path.startsWith('/') ? path.slice(1) : `${base}${path}`;
  const stack = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/**
 * 读取 xlsx。
 * @param {ArrayBuffer|Uint8Array|Blob|File} input
 * @returns {Promise<{sheets: Array<{name:string, rows:Array<Array<string|null>>}>}>}
 */
export async function readXlsx(input) {
  try {
    const bytes = await toBytes(input);
    if (bytes.length < 22) throw new Error('文件太小，不是有效的 xlsx');
    const entries = readZipDirectory(bytes);

    const workbookXml = await readXmlEntry(bytes, entries, 'xl/workbook.xml');
    if (!workbookXml) {
      throw new Error('缺少 xl/workbook.xml，不是有效的 xlsx 文件（可能是 .xls 改后缀）');
    }
    const relationshipsXml = await readXmlEntry(bytes, entries, 'xl/_rels/workbook.xml.rels');
    const relationships = parseRelationships(relationshipsXml);

    const sharedStringsXml = await readXmlEntry(bytes, entries, 'xl/sharedStrings.xml');
    const sharedStrings = parseSharedStrings(sharedStringsXml);

    // workbook.xml 里 <sheets> 的顺序即工作表顺序
    const sheetDefinitions = [];
    const sheetRe = /<sheet\b([^>]*?)\/?>/g;
    let sheetMatch;
    while ((sheetMatch = sheetRe.exec(workbookXml)) !== null) {
      const attributes = parseAttributes(sheetMatch[1]);
      const name = decodeXml(attributes.name || '');
      if (!name) continue;
      sheetDefinitions.push({ name, rid: attributes['r:id'] || attributes.id || '', state: attributes.state || 'visible' });
    }
    if (!sheetDefinitions.length) throw new Error('工作簿里没有任何工作表');

    const sheets = [];
    for (let index = 0; index < sheetDefinitions.length; index += 1) {
      const definition = sheetDefinitions[index];
      let sheetPath = '';
      const relation = definition.rid ? relationships.get(definition.rid) : null;
      if (relation && relation.target) {
        sheetPath = resolvePath('xl/', relation.target);
      }
      if (!sheetPath || !entries.has(sheetPath.toLowerCase())) {
        // 兜底：按顺序猜 worksheets/sheetN.xml
        const fallback = `xl/worksheets/sheet${index + 1}.xml`;
        if (entries.has(fallback.toLowerCase())) sheetPath = fallback;
      }
      if (!sheetPath) continue;
      const sheetXml = await readXmlEntry(bytes, entries, sheetPath);
      if (sheetXml == null) continue;
      sheets.push({ name: definition.name, rows: parseWorksheet(sheetXml, sharedStrings) });
    }
    if (!sheets.length) throw new Error('没有读到任何工作表数据');
    return { sheets };
  } catch (error) {
    if (error && typeof error.message === 'string' && error.message.startsWith('读取 xlsx 失败')) {
      throw error;
    }
    const message = error && error.message ? error.message : '未知错误';
    throw new Error(`读取 xlsx 失败：${message}`);
  }
}
