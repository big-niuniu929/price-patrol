/**
 * lib/xlsx-write.js —— 零依赖 xlsx 写出（浏览器/Node 通用）
 *
 * 自己实现：
 *   - ZIP 容器（local header + central directory + EOCD，CRC32 自算，deflate-raw 压缩）；
 *   - OOXML 工作簿（[Content_Types].xml、_rels、workbook、styles、worksheets）。
 * 单元格：字符串写 inlineStr、数字写数字、布尔写 t="b"；表头加粗+底色；可冻结表头行。
 *
 * 契约（DESIGN.md 第 10 节）：
 *   writeXlsx({ sheets: [{ name, columns?: [{header,width}], rows: [[...]], freeze?:boolean, headerRow?:number }] })
 *     -> Promise<Uint8Array>
 *   若给了 columns：columns 作为第 1 行表头写出，rows 只放数据行；
 *   若没给 columns：rows 里已包含表头行，用 headerRow（0-based）指定哪一行是表头（默认 0）。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** 计算 CRC32（ZIP 必需） */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 用浏览器/Node 原生 CompressionStream 做 deflate-raw；没有则退化为存储（Excel 也接受） */
async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') {
    return { data: bytes, raw: bytes, method: 0 };
  }
  try {
    // Blob.stream + pipeThrough 并发读写，避免大文件背压死锁
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return { data: new Uint8Array(buffer), raw: bytes, method: 8 };
  } catch (error) {
    return { data: bytes, raw: bytes, method: 0 };
  }
}

/** 简易字节写入器 */
class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  bytes(data) {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }

  u16(value) {
    return this.bytes([value & 0xff, (value >>> 8) & 0xff]);
  }

  u32(value) {
    return this.bytes([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
  }

  toUint8Array() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

const encoder = new TextEncoder();

/** 当前时间的 DOS 时间戳（ZIP 头部用） */
function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/**
 * 组装 ZIP（每项已压缩）。
 * @param {Array<{name:string, data:Uint8Array, raw:Uint8Array, method:number}>} entries
 *        data=压缩后字节，raw=原始字节（CRC/未压缩长度按 raw 计算）
 * @returns {Uint8Array}
 */
function buildZip(entries) {
  const { time, date } = dosDateTime();
  const local = new ByteWriter();
  const central = new ByteWriter();
  const infos = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const payload = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const raw = entry.raw instanceof Uint8Array ? entry.raw : payload;
    const uncompressedSize = raw.length;
    const method = entry.method === 8 ? 8 : 0;
    const crc = crc32(raw);
    const localOffset = local.length;

    // local file header
    local.u32(0x04034b50);
    local.u16(20); // version needed
    local.u16(0x0800); // UTF-8 文件名标志
    local.u16(method);
    local.u16(time);
    local.u16(date);
    local.u32(crc);
    local.u32(payload.length); // compressed size
    local.u32(uncompressedSize);
    local.u16(nameBytes.length);
    local.u16(0); // extra length
    local.bytes(nameBytes);
    local.bytes(payload);

    infos.push({ nameBytes, method, crc, compressedSize: payload.length, uncompressedSize, localOffset });
  }

  // central directory
  for (const info of infos) {
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x0800);
    central.u16(info.method);
    central.u16(time);
    central.u16(date);
    central.u32(info.crc);
    central.u32(info.compressedSize);
    central.u32(info.uncompressedSize);
    central.u16(info.nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(info.localOffset);
    central.bytes(info.nameBytes);
  }

  const centralOffset = local.length;
  const centralSize = central.length;
  const eocd = new ByteWriter();
  eocd.u32(0x06054b50);
  eocd.u16(0); // disk number
  eocd.u16(0); // central dir start disk
  eocd.u16(infos.length);
  eocd.u16(infos.length);
  eocd.u32(centralSize);
  eocd.u32(centralOffset);
  eocd.u16(0); // comment length

  return [local.toUint8Array(), central.toUint8Array(), eocd.toUint8Array()].reduce(
    (all, part) => concatBytes(all, part),
    new Uint8Array(0),
  );
}

/** 拼接字节数组 */
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** XML 文本转义，同时过滤 Excel 非法控制字符 */
function escapeXml(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 列号（0-based）→ Excel 列字母：0→A、25→Z、26→AA */
function columnLetter(index) {
  let n = index + 1;
  let text = '';
  while (n > 0) {
    const mod = (n - 1) % 26;
    text = String.fromCharCode(65 + mod) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

/** 单元格数字写法：整数不给小数点，避免 1e21 的科学计数法 */
function numberText(value) {
  if (Number.isInteger(value)) return String(value);
  if (Math.abs(value) >= 1e21 || (Math.abs(value) < 1e-6 && value !== 0)) {
    return value.toFixed(20).replace(/\.?0+$/, '');
  }
  return String(value);
}

/** 单元格 XML；空值返回 ''（直接不写 <c>） */
function cellXml(ref, value, styleIndex) {
  const style = styleIndex ? ` s="${styleIndex}"` : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return `<c r="${ref}"${style}><v>${numberText(value)}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (value instanceof Date) {
    const text = value.toISOString();
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }
  let text = String(value);
  if (!text) return '';
  if (text.length > 32767) text = `${text.slice(0, 32764)}...`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/** 粗略显示宽度（中文按 2 个字符宽计） */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1;
  }
  return width;
}

/** 依据内容计算列宽（无 columns[].width 时使用） */
function autoWidths(matrix) {
  const widths = [];
  for (const row of matrix) {
    for (let i = 0; i < row.length; i += 1) {
      const value = row[i];
      if (value === null || value === undefined) continue;
      const width = displayWidth(value instanceof Date ? value.toISOString() : value);
      widths[i] = Math.max(widths[i] || 0, width);
    }
  }
  return widths.map((width) => Math.min(60, Math.max(8, (width || 0) + 2)));
}

/** 表头样式索引（styles.xml 里的 cellXfs[1]） */
const HEADER_STYLE = 1;

/** 构造 worksheet XML */
function buildSheetXml(sheet, matrix, headerRowIndex, widths) {
  const rowCount = matrix.length;
  let maxColumn = 0;
  for (const row of matrix) maxColumn = Math.max(maxColumn, row.length);
  const dimension = rowCount > 0 && maxColumn > 0
    ? `A1:${columnLetter(maxColumn - 1)}${rowCount}`
    : 'A1';

  const freeze = sheet.freeze !== false && headerRowIndex >= 0;
  const ySplit = headerRowIndex + 1;
  const topLeftCell = `A${ySplit + 1}`;
  const panes = freeze && ySplit > 0
    ? `<pane xSplit="0" ySplit="${ySplit}" topLeftCell="${topLeftCell}" activePane="bottomLeft" state="frozen"/>`
    : '';

  const cols = widths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${Number(width.toFixed(2))}" customWidth="1"/>`)
    .join('');

  const rowsXml = [];
  matrix.forEach((row, rowIndex) => {
    const cells = [];
    for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
      const styleIndex = rowIndex === headerRowIndex ? HEADER_STYLE : 0;
      const xml = cellXml(`${columnLetter(colIndex)}${rowIndex + 1}`, row[colIndex], styleIndex);
      if (xml) cells.push(xml);
    }
    rowsXml.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`);
  });

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<dimension ref="${dimension}"/>`,
    `<sheetViews><sheetView workbookViewId="0"${freeze ? ' tabSelected="1"' : ''}>${panes}</sheetView></sheetViews>`,
    '<sheetFormatPr defaultRowHeight="15"/>',
    cols ? `<cols>${cols}</cols>` : '',
    `<sheetData>${rowsXml.join('')}</sheetData>`,
    '</worksheet>',
  ].join('');
}

/** 固定样式表：0=正文，1=表头（加粗+深蓝底+白字+居中） */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<fonts count="2">
<font><sz val="11"/><color theme="1"/><name val="等线"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="等线"/><family val="2"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** 工作簿核心属性 */
function buildCoreXml() {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>电商平台市占率数据工作台</dc:creator>
<cp:lastModifiedBy>电商平台市占率数据工作台</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>电商平台市占率数据工作台</Application>
</Properties>`;

/** 清理非法工作表名：≤31 字符、不允许 []:*?/\、非空、不可重复 */
function sanitizeSheetNames(sheets) {
  const used = new Set();
  return sheets.map((sheet, index) => {
    let name = String(sheet.name == null ? '' : sheet.name)
      .replace(/[[\]:*?/\\]/g, '_')
      .trim()
      .slice(0, 31);
    if (!name) name = `Sheet${index + 1}`;
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      const tail = `_${suffix}`;
      candidate = `${name.slice(0, 31 - tail.length)}${tail}`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/**
 * 写出 xlsx。
 * @param {{sheets: Array<{name:string, columns?:Array<{header:string,width?:number}>, rows:Array<Array<*>>, freeze?:boolean, headerRow?:number}>}} workbook
 * @returns {Promise<Uint8Array>}
 */
export async function writeXlsx(workbook) {
  try {
    if (!workbook || !Array.isArray(workbook.sheets) || workbook.sheets.length === 0) {
      throw new Error('没有可写出的工作表');
    }
    if (workbook.sheets.length > 200) {
      throw new Error('工作表数量过多（上限 200）');
    }
    const names = sanitizeSheetNames(workbook.sheets);
    const sheetEntries = workbook.sheets.map((sheet, index) => {
      const hasColumns = Array.isArray(sheet.columns) && sheet.columns.length > 0;
      const dataRows = Array.isArray(sheet.rows) ? sheet.rows : [];
      let matrix;
      let widths;
      let headerRowIndex;
      if (hasColumns) {
        matrix = [sheet.columns.map((column) => (column && column.header != null ? column.header : ''))].concat(dataRows);
        headerRowIndex = 0;
        widths = sheet.columns.map((column) => (column && Number(column.width) > 0 ? Number(column.width) : 0));
        const auto = autoWidths(matrix);
        widths = widths.map((width, i) => (width > 0 ? width : auto[i] || 10));
      } else {
        matrix = dataRows;
        headerRowIndex =
          Number.isInteger(sheet.headerRow) && sheet.headerRow >= 0 ? sheet.headerRow : 0;
        widths = autoWidths(matrix);
      }
      return {
        name: names[index],
        xml: buildSheetXml(sheet, matrix, headerRowIndex, widths),
      };
    });

    const sheetFiles = sheetEntries.map((entry, index) => ({
      path: `xl/worksheets/sheet${index + 1}.xml`,
      content: entry.xml,
    }));

    const contentTypes = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default ContentType="application/vnd.openxmlformats-package.relationships+xml" Extension="rels"/>',
      '<Default ContentType="application/xml" Extension="xml"/>',
      '<Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" PartName="/xl/workbook.xml"/>',
      '<Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" PartName="/xl/styles.xml"/>',
      '<Override ContentType="application/vnd.openxmlformats-package.core-properties+xml" PartName="/docProps/core.xml"/>',
      '<Override ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml" PartName="/docProps/app.xml"/>',
      ...sheetEntries.map(
        (_entry, index) =>
          `<Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/xl/worksheets/sheet${index + 1}.xml"/>`,
      ),
      '</Types>',
    ].join('');

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetEntries
  .map(
    (_entry, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  )
  .join('\n')}
<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView activeTab="0"/></bookViews>
<sheets>
${sheetEntries.map((entry, index) => `<sheet name="${escapeXml(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('\n')}
</sheets>
</workbook>`;

    const files = [
      { path: '[Content_Types].xml', content: contentTypes },
      { path: '_rels/.rels', content: rootRels },
      { path: 'docProps/core.xml', content: buildCoreXml() },
      { path: 'docProps/app.xml', content: APP_XML },
      { path: 'xl/workbook.xml', content: workbookXml },
      { path: 'xl/_rels/workbook.xml.rels', content: workbookRels },
      { path: 'xl/styles.xml', content: STYLES_XML },
      ...sheetFiles,
    ];

    const entries = new Array(files.length);
    for (let i = 0; i < files.length; i += 1) {
      const raw = encoder.encode(files[i].content);
      const { data, raw: original, method } = await deflateRaw(raw);
      entries[i] = { name: files[i].path, data, raw: original, method };
    }
    return buildZip(entries);
  } catch (error) {
    const message = error && error.message ? error.message : '未知错误';
    throw new Error(`xlsx 写出失败：${message}`);
  }
}
