import '../models/safety_permit.dart';
import 'arabic_format.dart';

/// يبني تقرير HTML بمقاس A4 لطلب تصريح عمل واحد — من بداية الطلب (بيانات
/// التقديم) وحتى قرار قسم السلامة النهائي (قبول بكل تفاصيل السلامة، أو رفض
/// بسببه، أو ما زال بانتظار المراجعة) — بنفس الهوية البصرية تمامًا لتقرير
/// الصيانة (راجع maintenance_report_html.dart) ليتحول لاحقًا لملف PDF عبر
/// حزمة printing (والتي تستخدم محرك عرض النظام نفسه، فتُخرج النص العربي
/// بشكل سليم دون أي إعداد إضافي).
String buildSafetyPermitHtml(SafetyPermit permit) {
  String row(String label, String value, {bool bold = false}) => '''
    <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #EDEFF2;">
      <span style="font-size:13px; color:#5C6673;">$label</span>
      <span style="font-size:14px; ${bold ? 'font-weight:700;' : ''} color:#1A2129;">$value</span>
    </div>
  ''';

  String tagList(List<String> items) {
    if (items.isEmpty) return '—';
    return items
        .map((t) => '<span style="display:inline-block; background:#EDEFF2; border-radius:8px; padding:3px 10px; font-size:12px; margin:2px;">$t</span>')
        .join('');
  }

  // مبنية كمتغيّرات مستقلة (وليست ''' متداخلة داخل الـ''' الرئيسية بالأسفل)
  // — التداخل يقطع النص الأصلي عند أول ''' يصادفها محرّك دارت (راجع نفس
  // الملاحظة في maintenance_report_html.dart).
  final String decisionBlock;
  switch (permit.status) {
    case PermitStatus.approved:
      decisionBlock = '''
  <div style="font-size:15px; font-weight:700; margin:20px 0 8px;">قرار قسم السلامة — مقبول</div>
  <div style="background:#EAF3EF; border-radius:12px; padding:14px 16px; font-size:13.5px; line-height:1.9; color:#1F7A63;">
    <div style="font-weight:700; margin-bottom:6px;">خلوّ الموقع من التالي</div>
    <div style="margin-bottom:12px;">${tagList(permit.siteHazards)}</div>
    <div style="font-weight:700; margin-bottom:6px;">المخاطر المحتملة</div>
    <div style="margin-bottom:12px;">${tagList(permit.potentialRisks)}</div>
    <div style="font-weight:700; margin-bottom:6px;">معدات الوقاية الشخصية المطلوبة</div>
    <div style="margin-bottom:12px;">${tagList(permit.ppeRequired)}</div>
    <div style="font-weight:700; margin-bottom:6px;">الإجراءات الإلزامية للتصريح</div>
    <div>${permit.precautions ?? '—'}</div>
  </div>
  ${row('راجعه', permit.reviewedBy ?? '—')}
  ${permit.reviewedAt != null ? row('تاريخ ووقت المراجعة', ArabicFormat.dateTime(permit.reviewedAt!)) : ''}
''';
      break;
    case PermitStatus.rejected:
      decisionBlock = '''
  <div style="font-size:15px; font-weight:700; margin:20px 0 8px;">قرار قسم السلامة — مرفوض</div>
  <div style="background:#FBEAEA; border-radius:12px; padding:14px 16px; font-size:13.5px; line-height:1.7; color:#B3261E;">
    <div style="font-weight:700; margin-bottom:6px;">سبب الرفض</div>
    <div>${permit.rejectionReason ?? '—'}</div>
  </div>
  ${row('راجعه', permit.reviewedBy ?? '—')}
  ${permit.reviewedAt != null ? row('تاريخ ووقت المراجعة', ArabicFormat.dateTime(permit.reviewedAt!)) : ''}
''';
      break;
    case PermitStatus.pending:
      decisionBlock = '''
  <div style="background:#FFF6E5; border-radius:12px; padding:14px 16px; font-size:13.5px; color:#7A5100; margin-top:8px;">
    لم تتم مراجعة هذا الطلب من قسم السلامة بعد.
  </div>
''';
      break;
  }

  return '''
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-adjust: exact; }
  body { margin: 0; }
</style>
</head>
<body>
<div dir="rtl" lang="ar" style="width:794px; min-height:1123px; box-sizing:border-box; background:#FFFFFF; font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif; color:#1A2129; padding:56px 60px; display:flex; flex-direction:column;">

  <div style="display:flex; align-items:flex-start; justify-content:space-between; padding-bottom:20px; border-bottom:2px solid #2B3487;">
    <div style="display:flex; flex-direction:column; gap:6px;">
      <div style="font-size:22px; font-weight:700; color:#2B3487;">تقرير تصريح عمل</div>
      <div style="font-size:14px; color:#5C6673;">رقم الطلب: #${permit.id}</div>
    </div>
    <div style="text-align:left; font-size:12.5px; color:#8892A0;">صيانتي — إدارة الصيانة والإنتاج والسلامة</div>
  </div>

  <div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:16px; padding:24px 0;">
    <div style="background:#F5F6F8; border-radius:12px; padding:16px;">
      <div style="font-size:12.5px; color:#5C6673; margin-bottom:6px;">الحالة</div>
      <div style="font-size:16px; font-weight:700; color:#2B3487;">${_statusLabel(permit.status)}</div>
    </div>
    <div style="background:#F5F6F8; border-radius:12px; padding:16px;">
      <div style="font-size:12.5px; color:#5C6673; margin-bottom:6px;">عدد العاملين</div>
      <div style="font-size:16px; font-weight:700; color:#2B3487;">${permit.workersCount}</div>
    </div>
    <div style="background:#F5F6F8; border-radius:12px; padding:16px;">
      <div style="font-size:12.5px; color:#5C6673; margin-bottom:6px;">نوع العمل</div>
      <div style="font-size:14px; font-weight:700; color:#7A5100;">${permit.operationTypesLabel}</div>
    </div>
  </div>

  <div style="font-size:15px; font-weight:700; margin:8px 0 4px;">بيانات الطلب</div>
  <div>
    ${row('الموقع', permit.officeName != null && permit.officeName!.isNotEmpty ? '${permit.location} (${permit.officeName})' : permit.location)}
    ${row('مقدّم الطلب', permit.requesterName)}
    ${row('تاريخ ووقت التقديم', ArabicFormat.dateTime(permit.requestedAt))}
    ${permit.startAt != null ? row('بداية العمل', ArabicFormat.dateTime(permit.startAt!)) : ''}
    ${permit.endAt != null ? row('نهاية العمل', ArabicFormat.dateTime(permit.endAt!)) : ''}
    ${permit.responsiblePhone != null && permit.responsiblePhone!.isNotEmpty ? row('جوال المسؤول', permit.responsiblePhone!) : ''}
    ${permit.equipmentUsed != null && permit.equipmentUsed!.isNotEmpty ? row('المعدات/الأدوات المستخدمة', permit.equipmentUsed!) : ''}
    ${permit.relatedWorkOrderId != null ? row('مرتبط ببلاغ صيانة رقم', '#${permit.relatedWorkOrderId}') : ''}
  </div>

  <div style="font-size:15px; font-weight:700; margin:20px 0 8px;">وصف العمل</div>
  <div style="background:#F5F6F8; border-radius:12px; padding:14px 16px; font-size:13.5px; line-height:1.7; color:#3A4250;">
    ${permit.description}
  </div>

  $decisionBlock

  <div style="margin-top:auto; padding-top:28px; border-top:1px solid #EDEFF2; font-size:11px; color:#B4BAC2; display:flex; justify-content:space-between;">
    <span>تم إنشاء هذا التقرير تلقائيًا من تطبيق صيانتي</span>
    <span>${ArabicFormat.dateTime(DateTime.now())}</span>
  </div>

</div>
</body>
</html>
''';
}

String _statusLabel(PermitStatus status) {
  switch (status) {
    case PermitStatus.pending:
      return 'بانتظار الموافقة';
    case PermitStatus.approved:
      return 'مقبول';
    case PermitStatus.rejected:
      return 'مرفوض';
  }
}
