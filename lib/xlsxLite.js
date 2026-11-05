'use strict';
// ============================================================================
// كاتب ملفات Excel (.xlsx) بلا أي مكتبة خارجية — يكفي لتقارير صيانتي:
// عدة أوراق، أنماط (خط/لون/حدود/محاذاة/صيغة تاريخ)، عرض الأعمدة، تجميد الصفوف والأعمدة،
// فلتر تلقائي، اتجاه الورقة من اليمين لليسار، إعداد الطباعة (أفقي + ملاءمة العرض + تكرار
// صف العنوان)، ودمج الخلايا. الملف الناتج حزمة ZIP عادية (zlib المدمجة في Node).
//
// الاستعمال:
//   const wb = new Workbook({ title: 'تقرير', creator: 'صيانتي' });
//   const head = wb.style({ bold: true, color: 'FFFFFF', fill: '1B6E87', align: 'center', border: true });
//   const ws = wb.addSheet('اسم الورقة', { rtl: true, landscape: true, widths: [8, 30], freeze: { rows: 1, cols: 0 }, autoFilter: true });
//   ws.addRow(['م', 'الاسم'].map((v) => ({ v, s: head })), { height: 24 });
//   ws.addRow([1, 'اسم', { v: new Date(), s: dateStyle, t: 'date' }]);
//   const buffer = wb.build();
// أنواع الخلية: نص (افتراضي للنصوص)، رقم، 'date' (رقم تسلسلي لإكسل + صيغة تاريخ)، {f: صيغة, v: القيمة المخزَّنة}.
// ============================================================================

const zlib = require('zlib');

// ---------------------------------------------------------------------------
// CRC32 + ZIP
// ---------------------------------------------------------------------------

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

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/** يبني ملف ZIP من [{name, data(Buffer)}] ويعيده Buffer. */
function zipFiles(files, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // الإصدار المطلوب
    lh.writeUInt16LE(0x0800, 6); // الأعلام: أسماء الملفات UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // صُنع بإصدار
    ch.writeUInt16LE(20, 6); // يلزمه إصدار
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------------------
// أدوات XML
// ---------------------------------------------------------------------------

// يحذف المحارف غير المسموحة في XML 1.0 ثم يهرّب الرموز الخاصة.
function xmlText(value) {
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
const xmlAttr = (value) => xmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** رقم عمود (١..) → حرف إكسل (A, B, … AA). */
function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** تاريخ (Date بتوقيت UTC، أو نص YYYY-MM-DD) → رقم تسلسلي لإكسل (أيام منذ 1899-12-30). */
function excelSerial(value) {
  let ms;
  if (value instanceof Date) ms = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    if (!m) return null;
    ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return Math.round(ms / 86400000) + 25569;
}

// اسم ورقة صالح: ≤31 حرفًا بلا  [ ] : * ? / \  وبلا علامة اقتباس في الأطراف.
function safeSheetName(name, used) {
  let s = Array.from(String(name).replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'ورقة')
    .slice(0, 31)
    .join('');
  let i = 2;
  const base = s;
  while (used.has(s.toLowerCase())) {
    const suffix = ` ${i++}`;
    s = Array.from(base).slice(0, 31 - suffix.length).join('') + suffix;
  }
  used.add(s.toLowerCase());
  return s;
}

// ---------------------------------------------------------------------------
// الأنماط
// ---------------------------------------------------------------------------

const BORDER_COLOR = 'C9CFD8';

class StyleBook {
  constructor() {
    this.fonts = [{ key: 'default', xml: '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' }];
    this.fills = [
      { key: 'none', xml: '<fill><patternFill patternType="none"/></fill>' },
      { key: 'gray125', xml: '<fill><patternFill patternType="gray125"/></fill>' },
    ];
    this.borders = [{ key: 'none', xml: '<border><left/><right/><top/><bottom/><diagonal/></border>' }];
    this.numFmts = []; // [{id, code}]
    this.xfs = [{ key: 'default', xml: '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' }];
    this.cache = new Map();
  }

  _index(list, key, xml) {
    const i = list.findIndex((x) => x.key === key);
    if (i >= 0) return i;
    list.push({ key, xml });
    return list.length - 1;
  }

  /**
   * def: { bold, size, color('RRGGBB'), fill('RRGGBB'), align('right'|'center'|'left'), valign,
   *        wrap, border(true|'RRGGBB'), numFmt('yyyy-mm-dd'|'#,##0'|…), rtl }
   */
  add(def = {}) {
    const k = JSON.stringify(def);
    if (this.cache.has(k)) return this.cache.get(k);

    const fontXml = `<font>${def.bold ? '<b/>' : ''}<sz val="${def.size || 11}"/>${
      def.color ? `<color rgb="FF${xmlAttr(def.color)}"/>` : ''
    }<name val="${xmlAttr(def.font || 'Calibri')}"/><family val="2"/></font>`;
    const fontId = this._index(this.fonts, fontXml, fontXml);

    let fillId = 0;
    if (def.fill) {
      const fx = `<fill><patternFill patternType="solid"><fgColor rgb="FF${xmlAttr(def.fill)}"/><bgColor indexed="64"/></patternFill></fill>`;
      fillId = this._index(this.fills, fx, fx);
    }

    let borderId = 0;
    if (def.border) {
      const c = typeof def.border === 'string' ? def.border : BORDER_COLOR;
      const side = (n) => `<${n} style="thin"><color rgb="FF${xmlAttr(c)}"/></${n}>`;
      const bx = `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
      borderId = this._index(this.borders, bx, bx);
    }

    let numFmtId = 0;
    if (def.numFmt) {
      const builtin = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4 };
      if (Object.prototype.hasOwnProperty.call(builtin, def.numFmt)) numFmtId = builtin[def.numFmt];
      else {
        let f = this.numFmts.find((x) => x.code === def.numFmt);
        if (!f) {
          f = { id: 164 + this.numFmts.length, code: def.numFmt };
          this.numFmts.push(f);
        }
        numFmtId = f.id;
      }
    }

    const align = `<alignment${def.align ? ` horizontal="${def.align}"` : ''} vertical="${def.valign || 'center'}"${
      def.wrap ? ' wrapText="1"' : ''
    }${def.rtl === false ? '' : ' readingOrder="2"'}/>`;
    const xfXml = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${
      numFmtId ? ' applyNumberFormat="1"' : ''
    } applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''} applyAlignment="1">${align}</xf>`;
    const id = this._index(this.xfs, xfXml, xfXml);
    this.cache.set(k, id);
    return id;
  }

  xml() {
    const numFmts = this.numFmts.length
      ? `<numFmts count="${this.numFmts.length}">${this.numFmts
          .map((f) => `<numFmt numFmtId="${f.id}" formatCode="${xmlAttr(f.code)}"/>`)
          .join('')}</numFmts>`
      : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      numFmts +
      `<fonts count="${this.fonts.length}">${this.fonts.map((x) => x.xml).join('')}</fonts>` +
      `<fills count="${this.fills.length}">${this.fills.map((x) => x.xml).join('')}</fills>` +
      `<borders count="${this.borders.length}">${this.borders.map((x) => x.xml).join('')}</borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${this.xfs.length}">${this.xfs.map((x) => x.xml).join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

// ---------------------------------------------------------------------------
// الورقة
// ---------------------------------------------------------------------------

class Sheet {
  constructor(book, name, opts) {
    this.book = book;
    this.name = name;
    this.opts = opts || {};
    this.rows = []; // [{cells, height}]
    this.merges = [];
  }

  /** يضيف صفًا؛ كل خلية: قيمة بسيطة أو {v, s, t, f}. يعيد رقم الصف (١..). */
  addRow(cells, { height } = {}) {
    this.rows.push({ cells: cells || [], height });
    return this.rows.length;
  }

  /** دمج نطاق: (صف١, عمود١, صف٢, عمود٢) كلها تبدأ من ١. */
  merge(r1, c1, r2, c2) {
    this.merges.push(`${colLetter(c1)}${r1}:${colLetter(c2)}${r2}`);
  }

  _cellXml(cell, ref) {
    if (cell === null || cell === undefined || cell === '') return null;
    let spec = cell;
    if (typeof cell !== 'object' || cell instanceof Date) spec = { v: cell };
    const s = spec.s ? ` s="${spec.s}"` : '';
    const v = spec.v;

    if (spec.f !== undefined) {
      // صيغة مع قيمة مخزَّنة (تُعاد حسابها عند الفتح)
      const f = `<f>${xmlText(spec.f)}</f>`;
      if (v === null || v === undefined || v === '') return `<c r="${ref}"${s} t="str">${f}<v></v></c>`;
      if (typeof v === 'number') return `<c r="${ref}"${s}>${f}<v>${v}</v></c>`;
      return `<c r="${ref}"${s} t="str">${f}<v>${xmlText(v)}</v></c>`;
    }
    if (v === null || v === undefined || v === '') {
      return spec.s ? `<c r="${ref}"${s}/>` : null; // خلية فارغة لكنها منسَّقة (حدود/تعبئة)
    }
    if (spec.t === 'date' || v instanceof Date) {
      const serial = excelSerial(v);
      if (serial === null) return `<c r="${ref}"${s} t="s"><v>${this.book._sst(String(v))}</v></c>`;
      return `<c r="${ref}"${s}><v>${serial}</v></c>`;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      return `<c r="${ref}"${s}><v>${v}</v></c>`;
    }
    if (typeof v === 'boolean') return `<c r="${ref}"${s} t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${s} t="s"><v>${this.book._sst(String(v))}</v></c>`;
  }

  xml(localIndex) {
    const o = this.opts;
    const maxCols = Math.max(1, ...this.rows.map((r) => r.cells.length), (o.widths || []).length);
    const lastRef = `${colLetter(maxCols)}${Math.max(1, this.rows.length)}`;

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    parts.push(`<sheetPr>${o.tabColor ? `<tabColor rgb="FF${xmlAttr(o.tabColor)}"/>` : ''}<pageSetUpPr fitToPage="1"/></sheetPr>`);
    parts.push(`<dimension ref="A1:${lastRef}"/>`);

    const freeze = o.freeze || {};
    const fr = freeze.rows || 0;
    const fc = freeze.cols || 0;
    let view = `<sheetView${o.rtl ? ' rightToLeft="1"' : ''}${localIndex === 0 ? ' tabSelected="1"' : ''} workbookViewId="0">`;
    if (fr || fc) {
      const tl = `${colLetter(fc + 1)}${fr + 1}`;
      const pane = fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
      view += `<pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${tl}" activePane="${pane}" state="frozen"/>`;
      view += `<selection pane="${pane}" activeCell="${tl}" sqref="${tl}"/>`;
    }
    view += '</sheetView>';
    parts.push(`<sheetViews>${view}</sheetViews>`);
    parts.push('<sheetFormatPr defaultRowHeight="18" customHeight="1"/>');

    if (o.widths && o.widths.length) {
      parts.push(
        '<cols>' +
          o.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') +
          '</cols>'
      );
    }

    parts.push('<sheetData>');
    this.rows.forEach((row, ri) => {
      const rn = ri + 1;
      const cellsXml = [];
      row.cells.forEach((cell, ci) => {
        const x = this._cellXml(cell, `${colLetter(ci + 1)}${rn}`);
        if (x) cellsXml.push(x);
      });
      const h = row.height ? ` ht="${row.height}" customHeight="1"` : '';
      parts.push(`<row r="${rn}"${h}>${cellsXml.join('')}</row>`);
    });
    parts.push('</sheetData>');

    if (o.autoFilter && this.rows.length > 0) {
      const headerRow = o.autoFilter === true ? 1 : o.autoFilter;
      parts.push(`<autoFilter ref="A${headerRow}:${colLetter(maxCols)}${this.rows.length}"/>`);
    }
    if (this.merges.length) {
      parts.push(`<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
    }
    parts.push('<printOptions horizontalCentered="1"/>');
    parts.push('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.25" footer="0.25"/>');
    parts.push(
      `<pageSetup paperSize="9" orientation="${o.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
    );
    parts.push('<headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter>');
    parts.push('</worksheet>');
    return parts.join('');
  }
}

// ---------------------------------------------------------------------------
// المصنّف
// ---------------------------------------------------------------------------

class Workbook {
  constructor({ title = '', creator = '' } = {}) {
    this.title = title;
    this.creator = creator;
    this.styles = new StyleBook();
    this.sheets = [];
    this._sstMap = new Map();
    this._sstList = [];
    this._sstRefs = 0;
    this._usedNames = new Set();
  }

  /** يسجّل نمط خلية ويعيد رقمه لاستعماله في {s: رقم}. */
  style(def) {
    return this.styles.add(def);
  }

  addSheet(name, opts) {
    const sheet = new Sheet(this, safeSheetName(name, this._usedNames), opts);
    this.sheets.push(sheet);
    return sheet;
  }

  _sst(str) {
    this._sstRefs++;
    let i = this._sstMap.get(str);
    if (i === undefined) {
      i = this._sstList.length;
      this._sstMap.set(str, i);
      this._sstList.push(str);
    }
    return i;
  }

  build(now = new Date()) {
    if (this.sheets.length === 0) this.addSheet('Sheet1', {});
    const sheetXmls = this.sheets.map((s, i) => s.xml(i)); // يملأ جدول النصوص المشتركة

    const sst =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this._sstRefs}" uniqueCount="${this._sstList.length}">` +
      this._sstList.map((t) => `<si><t xml:space="preserve">${xmlText(t)}</t></si>`).join('') +
      '</sst>';

    const quoted = (name) => `'${name.replace(/'/g, "''")}'`;
    const definedNames = [];
    this.sheets.forEach((s, i) => {
      const maxCols = Math.max(1, ...s.rows.map((r) => r.cells.length), (s.opts.widths || []).length);
      if (s.opts.autoFilter && s.rows.length > 0) {
        const hr = s.opts.autoFilter === true ? 1 : s.opts.autoFilter;
        definedNames.push(
          `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(quoted(s.name))}!$A$${hr}:$${colLetter(maxCols)}$${s.rows.length}</definedName>`
        );
      }
      if (s.opts.repeatRows) {
        definedNames.push(
          `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${xmlText(quoted(s.name))}!$${s.opts.repeatRows[0]}:$${s.opts.repeatRows[1]}</definedName>`
        );
      }
    });

    const workbook =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000"/></bookViews>' +
      '<sheets>' +
      this.sheets.map((s, i) => `<sheet name="${xmlAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets>' +
      (definedNames.length ? `<definedNames>${definedNames.join('')}</definedNames>` : '') +
      '<calcPr calcId="191029" fullCalcOnLoad="1"/>' +
      '</workbook>';

    const n = this.sheets.length;
    const workbookRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      this.sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      '</Relationships>';

    const contentTypes =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      this.sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';

    const rootRels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
    const core =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xmlText(this.title)}</dc:title><dc:creator>${xmlText(this.creator)}</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
      '</cp:coreProperties>';
    const app =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Sayanati</Application></Properties>';

    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'docProps/core.xml', data: core },
      { name: 'docProps/app.xml', data: app },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
      { name: 'xl/styles.xml', data: this.styles.xml() },
      { name: 'xl/sharedStrings.xml', data: sst },
      ...sheetXmls.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
    ];
    return zipFiles(files, now);
  }
}

module.exports = { Workbook, zipFiles, crc32, colLetter, excelSerial, xmlText };
