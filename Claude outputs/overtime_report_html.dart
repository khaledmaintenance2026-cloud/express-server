import '../models/overtime.dart';
import 'arabic_format.dart';

/// يبني تقرير "العمل الإضافي" كـ HTML بمقاس A4 — يوميًا (يوم واحد، بجدول توقيع
/// لكل عمل) أو شهريًا/لمدة (ملخص الأفراد + تفاصيل الأعمال) — بنفس هوية تقارير
/// صيانتي، ثم يتحول لملف PDF عبر حزمة printing (أندرويد) أو يُفتح في تبويب
/// متصفح للطباعة (ويب). راجع overtime_report_print_screen.dart.
///
/// كل نص يكتبه المستخدم (العمل، السبب، الموقع، أسماء الموظفين…) يمرّ عبر
/// [_esc] حتى لا يكسر رموز مثل < و & شكل التقرير.
String buildOvertimeReportHtml(OvertimeReport report) {
  final body = report.mode == 'day' ? _dayBody(report) : _periodBody(report);
  return _wrap(body);
}

// ---------------------------------------------------------------------------
// أدوات صغيرة
// ---------------------------------------------------------------------------

String _esc(String s) => s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/// نص متعدد الأسطر (السبب مثلًا): نهرّبه ثم نحوّل كل سطر جديد إلى <br>.
String _escMl(String s) => _esc(s).replaceAll('\r\n', '\n').replaceAll('\n', '<br>');

String _ar(Object v) => ArabicFormat.toEasternDigits(v);

const String _brand = 'صيانتي — إدارة الصيانة والإنتاج والسلامة';

// ---------------------------------------------------------------------------
// التنسيق (CSS) — مُعاينة بصريًا في Chromium بمقاس A4 قبل النقل إلى دارت.
// نص خام (r'''...''') كي لا يفسّر دارت أي رمز داخله.
// ---------------------------------------------------------------------------

const String _css = r'''
  @page { size: A4; margin: 12mm 10mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  body { margin: 0; background: #FFFFFF; }
  .page { width: 100%; max-width: 794px; margin: 0 auto; padding: 10px 8px 14px; font-family: 'IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif; color: #1A2129; font-size: 13px; line-height: 1.55; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 12px; border-bottom: 2px solid #2B3487; }
  .title { font-size: 21px; font-weight: 700; color: #2B3487; }
  .sub { font-size: 14px; color: #5C6673; margin-top: 3px; }
  .brand { font-size: 11.5px; color: #8892A0; text-align: left; white-space: nowrap; }
  .kpis { display: flex; gap: 10px; margin: 14px 0 6px; }
  .kpi { flex: 1; background: #F5F6F8; border-radius: 10px; padding: 10px 12px; }
  .kpi .k { font-size: 11.5px; color: #5C6673; }
  .kpi .v { font-size: 17px; font-weight: 700; color: #2B3487; margin-top: 2px; }
  .kpi .v.amber { color: #B45309; }
  .rec { border: 1px solid #D9DDE3; border-radius: 12px; padding: 12px 14px 12px; margin-top: 14px; break-inside: avoid; page-break-inside: avoid; }
  .rec.long { break-inside: auto; page-break-inside: auto; }
  .rec-head { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; }
  .badge { flex: none; width: 24px; height: 24px; line-height: 24px; text-align: center; border-radius: 50%; background: #2B3487; color: #FFFFFF; font-size: 12.5px; font-weight: 700; }
  .rec-title { font-size: 15px; font-weight: 700; }
  .grid { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-bottom: 8px; }
  .cell { background: #F5F6F8; border-radius: 8px; padding: 5px 10px; font-size: 12px; }
  .cell span { color: #5C6673; margin-left: 5px; }
  .cell b { color: #1A2129; }
  .box { background: #FFF8E6; border-radius: 8px; padding: 7px 11px; margin-bottom: 8px; font-size: 12.5px; }
  .box .lbl { font-weight: 700; color: #B45309; margin-bottom: 1px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  thead { display: table-header-group; }
  th { background: #2B3487; color: #FFFFFF; font-size: 12px; padding: 6px 8px; border: 1px solid #2B3487; text-align: right; }
  td { border: 1px solid #C9CFD8; padding: 0 8px; height: 34px; font-size: 12.5px; vertical-align: middle; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td.n { width: 38px; text-align: center; color: #5C6673; }
  td.num { width: 120px; text-align: center; }
  td.sign { width: 190px; }
  td.c { text-align: center; white-space: nowrap; }
  td.empty { height: 38px; text-align: center; color: #8892A0; }
  td.days { font-size: 11.5px; line-height: 1.5; padding-top: 4px; padding-bottom: 4px; }
  tfoot td { font-weight: 700; background: #F5F6F8; }
  .sec { font-size: 14.5px; font-weight: 700; margin: 18px 0 6px; color: #1A2129; }
  .note { font-size: 11.5px; color: #8892A0; margin-top: 8px; }
  .approve { margin-top: 26px; display: flex; gap: 40px; font-size: 12.5px; color: #3A4250; break-inside: avoid; }
  .approve div { flex: 1; border-top: 1px solid #8892A0; padding-top: 5px; text-align: center; }
  .foot { margin-top: 22px; padding-top: 10px; border-top: 1px solid #EDEFF2; font-size: 10.5px; color: #B4BAC2; display: flex; justify-content: space-between; }
''';

String _wrap(String body) {
  final generated = ArabicFormat.dateTime(DateTime.now());
  return '''<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<style>$_css</style>
</head>
<body>
<div class="page" dir="rtl">
$body
  <div class="foot"><span>تم إنشاء هذا التقرير تلقائيًا من تطبيق صيانتي</span><span>$generated</span></div>
</div>
</body>
</html>''';
}

String _head(String title, String sub, {String? sub2}) =>
    '''  <div class="head"><div><div class="title">${_esc(title)}</div><div class="sub">${_esc(sub)}</div>${sub2 == null ? '' : '<div class="sub">${_esc(sub2)}</div>'}</div><div class="brand">$_brand</div></div>''';

String _kpi(String label, String value, {bool amber = false}) =>
    '<div class="kpi"><div class="k">${_esc(label)}</div><div class="v${amber ? ' amber' : ''}">${_esc(value)}</div></div>';

String _cell(String label, String value) => '<div class="cell"><span>${_esc(label)}</span><b>${_esc(value)}</b></div>';

String _numberOrDash(String? employeeNumber) =>
    (employeeNumber == null || employeeNumber.isEmpty) ? '—' : _esc(_ar(employeeNumber));

const String _approveBlock = '  <div class="approve"><div>اعتماد المسؤول</div><div>التوقيع</div></div>';

// ---------------------------------------------------------------------------
// تقرير يوم واحد
// ---------------------------------------------------------------------------

String _recordBlock(int index, OvertimeRecord r) {
  final cells = StringBuffer();
  if (r.location != null) cells.write(_cell('الموقع', r.location!));
  if (r.lines != null) cells.write(_cell('الخطوط', r.lines!));
  if (r.product != null) cells.write(_cell('المنتج', r.product!));
  if (r.batch != null) cells.write(_cell('الباتش', r.batch!));
  final count = (r.workersCount != null && r.workersCount! > 0) ? r.workersCount! : r.employeesCount;
  if (count > 0) cells.write(_cell('عدد العمال', _ar(count)));
  if (r.startTime != null && r.endTime != null) {
    cells.write(_cell('الوقت', 'من ${_ar(r.startTime!)} إلى ${_ar(r.endTime!)}'));
    if (r.hours != null) cells.write(_cell('المدة', overtimeHoursLabel(r.hours!)));
  }
  final grid = cells.isEmpty ? '' : '<div class="grid">$cells</div>';

  final reason = r.reason == null
      ? ''
      : '<div class="box"><div class="lbl">سبب العمل الإضافي</div>${_escMl(r.reason!)}</div>';

  final rows = StringBuffer();
  if (r.entries.isEmpty) {
    rows.write('<tr><td class="empty" colspan="4">لم يُحدَّد أفراد لهذا العمل</td></tr>');
  } else {
    for (var k = 0; k < r.entries.length; k++) {
      final e = r.entries[k];
      rows.write('<tr><td class="n">${_ar(k + 1)}</td><td>${_esc(e.name)}</td>'
          '<td class="num">${_numberOrDash(e.employeeNumber)}</td><td class="sign"></td></tr>');
    }
  }

  final longClass = r.entries.length > 12 ? ' long' : '';
  return '''  <div class="rec$longClass">
    <div class="rec-head"><span class="badge">${_ar(index + 1)}</span><span class="rec-title">${_esc(r.workDescription)}</span></div>
    $grid
    $reason
    <table>
      <thead><tr><th>م</th><th>اسم الموظف</th><th>الرقم الوظيفي</th><th>التوقيع</th></tr></thead>
      <tbody>$rows</tbody>
    </table>
  </div>''';
}

String _dayBody(OvertimeReport report) {
  final s = report.summary;
  final date = overtimeParseDate(report.from);
  final sub = date == null
      ? overtimeDateLabel(report.from)
      : '${overtimeWeekdayName(date)} ${overtimeDateLabel(report.from)}';

  final kpis = StringBuffer()
    ..write(_kpi('عدد الأعمال', _ar(s.recordsCount)))
    ..write(_kpi('عدد الأفراد', _ar(s.employeesCount)));
  if (s.totalHours > 0) {
    final label = s.personHours > 0 ? 'إجمالي ساعات الأفراد' : 'إجمالي الساعات';
    final value = s.personHours > 0 ? s.personHours : s.totalHours;
    kpis.write(_kpi(label, overtimeHoursLabel(value), amber: true));
  }

  final recs = StringBuffer();
  for (var i = 0; i < report.records.length; i++) {
    if (i > 0) recs.write('\n');
    recs.write(_recordBlock(i, report.records[i]));
  }

  return '''${_head('تقرير العمل الإضافي اليومي', sub)}
  <div class="kpis">$kpis</div>
$recs
$_approveBlock''';
}

// ---------------------------------------------------------------------------
// تقرير شهر أو مدة
// ---------------------------------------------------------------------------

String _periodBody(OvertimeReport report) {
  final s = report.summary;

  late final String title;
  late final String sub;
  if (report.mode == 'month') {
    final monthPart = report.from.length >= 7 ? report.from.substring(0, 7) : report.from;
    final d = overtimeParseDate('$monthPart-01');
    title = 'تقرير العمل الإضافي الشهري';
    sub = d == null ? overtimeDateLabel(report.from) : 'شهر ${overtimeMonthName(d.month)} ${_ar(d.year)}';
  } else {
    title = 'تقرير العمل الإضافي';
    sub = 'من ${overtimeDateLabel(report.from)} إلى ${overtimeDateLabel(report.to)}';
  }

  final kpis = StringBuffer()
    ..write(_kpi('عدد الأعمال', _ar(s.recordsCount)))
    ..write(_kpi('أيام العمل الإضافي', _ar(s.daysCount)))
    ..write(_kpi('عدد الأفراد', _ar(s.employeesCount)));
  if (s.personHours > 0) {
    kpis.write(_kpi('إجمالي ساعات الأفراد', overtimeHoursLabel(s.personHours), amber: true));
  }

  var people = '';
  if (s.employees.isNotEmpty) {
    final prow = StringBuffer();
    for (var k = 0; k < s.employees.length; k++) {
      final p = s.employees[k];
      final daysLine = overtimeDaysLine(p.days, monthMode: report.mode == 'month', withHours: true);
      prow.write('<tr><td class="n">${_ar(k + 1)}</td><td>${_esc(p.name)}</td>'
          '<td class="num">${_numberOrDash(p.employeeNumber)}</td>'
          '<td class="c">${_ar(p.recordsCount)}</td><td class="c">${_ar(p.daysCount)}</td>'
          '<td class="days">${daysLine.isEmpty ? '—' : _esc(daysLine)}</td>'
          '<td class="c">${p.hours > 0 ? overtimeHoursLabel(p.hours) : '—'}</td></tr>');
    }
    people = '''<div class="sec">ملخص الأفراد</div>
  <table><thead><tr><th>م</th><th>اسم الموظف</th><th>الرقم الوظيفي</th><th>عدد المرات</th><th>عدد الأيام</th><th>الأيام</th><th>إجمالي الساعات</th></tr></thead><tbody>$prow</tbody></table>''';
  }

  final drow = StringBuffer();
  for (final r in report.records) {
    drow.write('<tr><td class="num">${overtimeDateLabel(r.workDate)}</td><td>${_esc(r.workDescription)}</td>'
        '<td>${r.reason == null ? '—' : _esc(r.reason!)}</td>'
        '<td>${r.location == null ? '—' : _esc(r.location!)}</td>'
        '<td class="c">${_ar(r.employeesCount)}</td>'
        '<td class="c">${(r.hours != null && r.hours! > 0) ? overtimeHoursLabel(r.hours!) : '—'}</td></tr>');
  }
  final detail = '''<div class="sec">تفاصيل الأعمال</div>
  <table><thead><tr><th>التاريخ</th><th>العمل</th><th>السبب</th><th>الموقع</th><th>الأفراد</th><th>المدة</th></tr></thead><tbody>$drow</tbody></table>''';

  final note = s.recordsWithoutHours > 0
      ? '<div class="note">ملاحظة: ${_ar(s.recordsWithoutHours)} من الأعمال بلا وقت محدد، لذلك لا تدخل ساعاتها في الإجماليات.</div>'
      : '';

  return '''${_head(title, sub)}
  <div class="kpis">$kpis</div>
  $people
  $detail
  $note
$_approveBlock''';
}

// ---------------------------------------------------------------------------
// كشف فرد واحد (شهر أو سنة): أيامه وساعات كل يوم + تفاصيل الأعمال
// ---------------------------------------------------------------------------

/// يبني كشف العمل الإضافي لفرد واحد كـ HTML بمقاس A4 — راجع
/// [OvertimePersonReport]. يُطبع ويُوقَّع من المسؤول والموظف.
String buildOvertimePersonReportHtml(OvertimePersonReport report) {
  final e = report.employee;
  final number = e.employeeNumber;
  final who = number == null ? e.name : '${e.name} — الرقم الوظيفي: ${_ar(number)}';

  final kpis = StringBuffer()
    ..write(_kpi('عدد مرات الإضافي', _ar(report.recordsCount)))
    ..write(_kpi('عدد الأيام', _ar(report.daysCount)));
  if (report.hours > 0) kpis.write(_kpi('إجمالي الساعات', overtimeHoursLabel(report.hours), amber: true));

  final body = StringBuffer();
  body.write(_head('كشف العمل الإضافي للموظف', who, sub2: overtimePeriodLabel(report.mode, report.from, report.to)));
  body.write('\n  <div class="kpis">$kpis</div>');

  if (report.records.isEmpty) {
    body.write('\n  <div class="note">لا يوجد عمل إضافي مسجَّل لهذا الفرد في هذه الفترة.</div>');
  } else {
    final drow = StringBuffer();
    var totalCount = 0;
    var totalHours = 0.0;
    for (var k = 0; k < report.days.length; k++) {
      final d = report.days[k];
      totalCount += d.recordsCount;
      totalHours += d.hours;
      final date = overtimeParseDate(d.date);
      drow.write('<tr><td class="n">${_ar(k + 1)}</td><td class="num">${overtimeDateLabel(d.date)}</td>'
          '<td>${date == null ? '' : overtimeWeekdayName(date)}</td>'
          '<td class="c">${_ar(d.recordsCount)}</td>'
          '<td class="c">${d.hours > 0 ? overtimeHoursLabel(d.hours) : '—'}</td></tr>');
    }
    body.write('''
  <div class="sec">الأيام</div>
  <table><thead><tr><th>م</th><th>التاريخ</th><th>اليوم</th><th>عدد الأعمال</th><th>الساعات</th></tr></thead><tbody>$drow</tbody>
  <tfoot><tr><td colspan="3">الإجمالي (${_ar(report.days.length)} يوم)</td><td class="c">${_ar(totalCount)}</td><td class="c">${totalHours > 0 ? overtimeHoursLabel(totalHours) : '—'}</td></tr></tfoot></table>''');

    final rrow = StringBuffer();
    for (final r in report.records) {
      final time = (r.startTime != null && r.endTime != null)
          ? 'من ${_ar(r.startTime!)} إلى ${_ar(r.endTime!)}'
          : '—';
      rrow.write('<tr><td class="num">${overtimeDateLabel(r.workDate)}</td><td>${_esc(r.workDescription)}</td>'
          '<td>${r.reason == null ? '—' : _esc(r.reason!)}</td>'
          '<td>${r.location == null ? '—' : _esc(r.location!)}</td>'
          '<td class="c">$time</td>'
          '<td class="c">${(r.hours != null && r.hours! > 0) ? overtimeHoursLabel(r.hours!) : '—'}</td></tr>');
    }
    body.write('''
  <div class="sec">تفاصيل الأعمال</div>
  <table><thead><tr><th>التاريخ</th><th>العمل</th><th>السبب</th><th>الموقع</th><th>الوقت</th><th>المدة</th></tr></thead><tbody>$rrow</tbody></table>''');

    if (report.recordsWithoutHours > 0) {
      body.write(
          '\n  <div class="note">ملاحظة: ${_ar(report.recordsWithoutHours)} من الأعمال بلا وقت محدد، لذلك لا تدخل ساعاتها في الإجماليات.</div>');
    }
  }

  body.write('\n  <div class="approve"><div>توقيع الموظف</div><div>اعتماد المسؤول</div></div>');
  return _wrap(body.toString());
}
