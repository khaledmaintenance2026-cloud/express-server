/// نوع أمر العمل: بلاغ عطل طارئ يرفعه الإنتاج، أو عمل آخر/وقائي يبادر به مشرف الصيانة.
enum MaintenanceKind { emergency, preventive }

enum MaintenanceStatus { pendingAssignment, inProgress, completed }

/// يحوّل حالة أمر العمل كما يخزّنها السيرفر (جدول work_orders — أدق من ٣
/// حالات: new/pending_assignment/waiting_loto/in_progress/waiting_parts/
/// completed/cancelled) إلى الحالات الثلاث التي تتوقعها واجهة التطبيق
/// الحالية. "ملغى" تُعامَل كمُنجزة حتى لا تبقى عالقة للأبد في لوحة العمل
/// اليومية — تمييزها بشكل مستقل إضافة مستقبلية جيدة لو احتجتموها.
MaintenanceStatus _statusFromApi(String? s) {
  switch (s) {
    case 'completed':
    case 'cancelled':
      return MaintenanceStatus.completed;
    case 'new':
    case 'pending_assignment':
      return MaintenanceStatus.pendingAssignment;
    default: // waiting_loto, in_progress, waiting_parts
      return MaintenanceStatus.inProgress;
  }
}

class MaintenanceReport {
  final String id;
  final String equipment;
  final String? equipmentCode; // كود المكينة — اختياري، يُعبَّأ عند إنشاء أمر عمل وقائي جديد
  final String line; // الخط / الموقع
  final String description;
  final MaintenanceKind kind;
  MaintenanceStatus status;

  final String reportedBy;
  final DateTime reportedAt;

  List<String> assignedTechnicianIds;
  DateTime? assignedAt;

  /// اسم الفني المُسنَد إليه أمر العمل — يصل جاهزًا من السيرفر (JOIN على جدول
  /// الفنيين)، يُستخدم للعرض بدل معرّف الفني الخام. يبقى "الفني الأساسي"
  /// فقط لأي شاشة قديمة تعرضه وحده.
  String? technicianName;

  /// كل الفنيين المُسنَد إليهم أمر العمل نفسه، مفصولين بـ"، " — يدعم النظام
  /// الآن تعيين أكثر من فني لنفس البلاغ (راجع work_order_technicians على
  /// السيرفر). يُستخدم للعرض بدل [technicianName] حين يتوفر.
  String? technicianNames;

  String? closeDescription;

  /// ملاحظات اختيارية منفصلة عن "بيان العمل المنجز" — يعبّئها الفني عند
  /// إغلاق أمر العمل، تظهر لاحقًا في رسالة واتساب "تم النجاح في الصيانة".
  String? closeNotes;
  String? partsUsed;
  DateTime? closedAt;

  /// للأعمال الوقائية فقط: كل كم يوم يُذكَّر المسؤول بإعادة فتح هذا العمل.
  final int? reminderIntervalDays;

  /// "مهمة عمل" (داخلية/خارجية) — تصنيف ثالث منفصل عن بلاغ العطل الطارئ
  /// والصيانة الوقائية، يبادره فريق الصيانة نفسه لمهام عامة لا ترتبط بعطل
  /// فعلي في معدة (توصيل، نقل معدات، أعمال إدارية...). يبقى [kind] هنا
  /// emergency عمدًا (فتظهر ضمن نفس تبويب "الأعطال الطارئة" وتتبع نفس دورة
  /// العمل/الإشعارات تمامًا) — [isTask]/[taskScope] فقط للتمييز في الإنشاء
  /// والتقارير (راجع maintenance_new_report_screen.dart).
  final bool isTask;
  final String? taskScope; // 'internal' | 'external' — فقط عند isTask == true

  MaintenanceReport({
    required this.id,
    required this.equipment,
    this.equipmentCode,
    required this.line,
    required this.description,
    required this.kind,
    this.status = MaintenanceStatus.pendingAssignment,
    required this.reportedBy,
    required this.reportedAt,
    List<String>? assignedTechnicianIds,
    this.assignedAt,
    this.technicianName,
    this.technicianNames,
    this.closeDescription,
    this.closeNotes,
    this.partsUsed,
    this.closedAt,
    this.reminderIntervalDays,
    this.isTask = false,
    this.taskScope,
  }) : assignedTechnicianIds = assignedTechnicianIds ?? [];

  /// يبني بلاغ/أمر عمل صيانة من استجابة سيرفر صيانتي المحلي (جدول
  /// work_orders) — كان هذا النوع محليًا فقط (Mock) على كل جهاز قبل هذا
  /// التحديث، الآن مربوط فعليًا بالسيرفر مثل باقي أقسام النظام.
  factory MaintenanceReport.fromApi(Map<String, dynamic> d) => MaintenanceReport(
        id: d['id'].toString(),
        equipment: (d['equipment_name'] as String?) ?? '',
        equipmentCode: d['equipment_code'] as String?,
        line: (d['facility'] as String?) ?? '',
        description: (d['description'] as String?) ?? '',
        kind: d['kind'] == 'preventive' ? MaintenanceKind.preventive : MaintenanceKind.emergency,
        status: _statusFromApi(d['status'] as String?),
        reportedBy: (d['created_by'] as String?) ?? '',
        reportedAt: DateTime.tryParse(d['created_at']?.toString() ?? '') ?? DateTime.now(),
        assignedTechnicianIds: d['assigned_technician_id'] != null ? [d['assigned_technician_id'].toString()] : [],
        assignedAt: d['assigned_at'] == null ? null : DateTime.tryParse(d['assigned_at'].toString()),
        technicianName: d['technician_name'] as String?,
        technicianNames: d['technician_names'] as String?,
        closeDescription: d['close_description'] as String?,
        closeNotes: d['close_notes'] as String?,
        closedAt: d['completed_at'] == null ? null : DateTime.tryParse(d['completed_at'].toString()),
        reminderIntervalDays: (d['reminder_interval_days'] as num?)?.round(),
        isTask: (d['is_task'] as bool?) ?? false,
        taskScope: d['task_scope'] as String?,
      );

  /// اسم/أسماء الفني(ين) الجاهزة للعرض — تُفضّل قائمة الفنيين المتعددين
  /// [technicianNames] إن توفرت، وإلا تعود لاسم الفني الأساسي وحده.
  String get technicianDisplayNames => technicianNames ?? technicianName ?? '—';

  /// المدة الزمنية من لحظة رفع البلاغ إلى لحظة إغلاقه — يحسبها التطبيق تلقائيًا،
  /// وليس على الفني إدخالها يدويًا.
  Duration? get duration {
    if (closedAt == null) return null;
    return closedAt!.difference(reportedAt);
  }

  bool get isEmergency => kind == MaintenanceKind.emergency;
}

/// متوسط زمن الإصلاح لمجموعة من البلاغات/أوامر العمل المُنجزة فقط — null لو
/// لم يوجد أي عمل منجز بعد ضمن القائمة الممرَّرة.
Duration? averageMaintenanceResolution(Iterable<MaintenanceReport> reports) {
  final durations = reports.map((r) => r.duration).whereType<Duration>().toList();
  if (durations.isEmpty) return null;
  final totalMs = durations.fold<int>(0, (sum, d) => sum + d.inMilliseconds);
  return Duration(milliseconds: (totalMs / durations.length).round());
}
