/// سجل تعديل واحد على باتش قديم — من عدّل، متى، وما الحقول التي تغيّرت
/// فعليًا (قيمتها القديمة والجديدة) — راجع GET
/// /api/production/batches/:id/edits وجدول production_batch_edits.
class BatchEdit {
  final String id;
  final String? editedByName;
  final DateTime editedAt;

  /// كل مفتاح هو اسم الحقل الذي تغيّر، وقيمته {old, new} كما وصلت من
  /// السيرفر (نصوص أو أرقام حسب الحقل) — تُعرض كما هي دون تفسير إضافي.
  final Map<String, dynamic> changes;

  BatchEdit({
    required this.id,
    this.editedByName,
    required this.editedAt,
    required this.changes,
  });

  factory BatchEdit.fromApi(Map<String, dynamic> d) => BatchEdit(
        id: d['id'].toString(),
        editedByName: d['edited_by_name'] as String?,
        editedAt: DateTime.tryParse(d['edited_at']?.toString() ?? '') ?? DateTime.now(),
        changes: (d['changes'] as Map?)?.cast<String, dynamic>() ?? const {},
      );
}

/// تسمية عربية لاسم الحقل كما يظهر في سجل التعديلات — لا علاقة له بأسماء
/// الأعمدة أو مفاتيح الـAPI، فقط للعرض.
String batchFieldLabel(String key) {
  switch (key) {
    case 'lineId':
      return 'الخط';
    case 'batchNumber':
      return 'رقم الباتش';
    case 'productName':
      return 'اسم المنتج';
    case 'quantity':
      return 'الكمية';
    case 'hasStoppage':
      return 'وجود توقف';
    case 'stoppageReason':
      return 'سبب التوقف';
    case 'stoppageMinutes':
      return 'دقائق التوقف';
    case 'operationalNotes':
      return 'ملاحظات تشغيلية';
    case 'actionsTaken':
      return 'الحلول والإجراءات المتخذة';
    case 'workersCount':
      return 'عدد العمال';
    case 'timeFrom':
      return 'وقت البدء';
    case 'timeTo':
      return 'وقت الانتهاء';
    case 'preventionMethods':
      return 'طرق تجنّب تكرار المشكلة';
    case 'occurredAt':
      return 'تاريخ الباتش';
    case 'workOrderId':
      return 'أمر الصيانة المرتبط';
    default:
      return key;
  }
}
