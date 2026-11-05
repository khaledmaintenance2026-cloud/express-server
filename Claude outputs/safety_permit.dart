enum PermitStatus { pending, approved, rejected }

PermitStatus _statusFromApi(String? s) => switch (s) {
      'approved' => PermitStatus.approved,
      'rejected' => PermitStatus.rejected,
      _ => PermitStatus.pending,
    };

/// أنواع الأعمال الخطرة — نفس القيم بالضبط المستخدمة في عمود operation_types
/// على السيرفر (راجع routes/safetyPermits.js، OPERATION_TYPES) والتسميات
/// المعروضة في رسائل واتساب (services/notifications.js، OPERATION_TYPE_LABELS)
/// — يجب أن يبقى المفتاح مطابقًا حرفيًا بين الطرفين.
const Map<String, String> kOperationTypeLabels = {
  'hot_work': 'أعمال حرارية/لحام',
  'confined_space': 'أماكن مغلقة',
  'height': 'العمل على مرتفعات',
  'electrical': 'كهرباء',
  'excavation': 'حفريات',
  'lifting': 'أعمال رفع',
  'other': 'أخرى',
};

/// خيارات "خلو الموقع من التالي" — تُعبَّأ من قسم السلامة قبل القبول فقط،
/// مطابقة تمامًا لاستمارة "إجراءات ومتطلبات السلامة لتصريح العمل" الورقية.
/// يمكن اختيار أكثر من عنصر.
const List<String> kSiteHazardOptions = [
  'تتطلب مراجعة من قبل قسم السلامة',
  'مواد قابلة للاشتعال',
  'المنتجات',
  'العاملين',
  'الحواجز',
  'انسكاب ماء/زيوت',
  'معدات غير آمنة',
  'الضوضاء',
];

/// خيارات "المخاطر المحتملة" — تُعبَّأ عند القبول فقط. يمكن اختيار أكثر من عنصر.
const List<String> kPotentialRiskOptions = [
  'سقوط معدات / عاملين',
  'انزلاق / تعثر',
  'خلل في التهوية / الإضاءة',
  'خلل في المعدات',
  'صعق كهربائي',
  'حروق',
];

/// خيارات "معدات الوقاية الشخصية التي يجب توفرها" — تُعبَّأ عند القبول فقط.
/// يمكن اختيار أكثر من عنصر، بالإضافة لخيار "أخرى" بنص حر في الشاشة.
const List<String> kPpeOptions = [
  'حذاء سلامة',
  'نظارة عاكسة',
  'خوذة رأس',
  'بطانية حريق',
  'بطانية لحام',
  'سروال مقاوم للحريق',
  'قفازات مقاومة',
  'حزام الأمان',
  'طفاية حريق',
  'معدات ميكانيكية يوجد بها حماية',
];

/// بيانات المهمة (أمر العمل) المرتبطة بتصريح — تصل من السيرفر مع التصريح نفسه
/// (أعمدة wo_* في GET/POST/PATCH /api/safety-permits، راجع PERMIT_WITH_TASK_SELECT
/// في routes/safetyPermits.js) حتى يعرف مسؤول السلامة ما هي المهمة بالضبط عند
/// المراجعة بدل رؤية عبارة "مرتبط ببلاغ صيانة" فقط.
class PermitTask {
  final String id;
  final String kind; // emergency | preventive
  final String description;
  final String status; // new / pending_assignment / waiting_loto / in_progress / waiting_parts / completed / cancelled
  final String? equipmentName;
  final String? equipmentCode;
  final String? facility;
  final String? lineName;
  final String? createdBy;
  final DateTime? createdAt;
  final String? technicianNames;

  const PermitTask({
    required this.id,
    required this.kind,
    required this.description,
    required this.status,
    this.equipmentName,
    this.equipmentCode,
    this.facility,
    this.lineName,
    this.createdBy,
    this.createdAt,
    this.technicianNames,
  });

  String get kindLabel => kind == 'preventive' ? 'صيانة وقائية' : 'بلاغ عطل طارئ';

  String get statusLabel => switch (status) {
        'new' => 'جديد',
        'pending_assignment' => 'بانتظار تعيين فني',
        'waiting_loto' => 'بانتظار عزل الطاقة / التصريح',
        'in_progress' => 'قيد التنفيذ',
        'waiting_parts' => 'بانتظار قطع غيار',
        'completed' => 'منجزة',
        'cancelled' => 'ملغاة',
        _ => status,
      };

  /// "المصنع / الخط" بدون أي جزء ناقص.
  String get locationLabel {
    final parts = [facility, lineName].where((e) => e != null && e.trim().isNotEmpty).cast<String>().toList();
    return parts.isEmpty ? '—' : parts.join(' / ');
  }

  String get equipmentLabel {
    if (equipmentName == null || equipmentName!.trim().isEmpty) return '—';
    final code = equipmentCode;
    return (code == null || code.trim().isEmpty) ? equipmentName! : '$equipmentName ($code)';
  }
}

class SafetyPermit {
  final String id;
  final String? officeName;
  final String location;
  final String description;
  final int workersCount;
  final String? responsiblePhone;
  final List<String> operationTypes;
  final String? equipmentUsed;

  /// مسار نسبي على السيرفر (مثال: /uploads/safety-permits/xxx.jpg) — يُبنى
  /// الرابط الكامل للعرض بإضافة عنوان السيرفر الأساسي (راجع ApiClient.baseUrl).
  final String? equipmentPhoto;

  final DateTime? startAt;
  final DateTime? endAt;

  final String requesterName; // من requested_by (اسم مقدّم الطلب وقت التقديم)

  /// ربط اختياري ببلاغ/أمر عمل صيانة قائم — إن وُجد بلاغ عند طلب التصريح.
  final String? relatedWorkOrderId;

  /// تفاصيل المهمة المرتبطة (وصفها، موقعها، معدتها، حالتها، فنيوها) — null لو
  /// التصريح غير مرتبط بأمر عمل، أو لو لم يحمل رد السيرفر هذه الأعمدة.
  final PermitTask? relatedTask;

  PermitStatus status;
  String? reviewedBy; // من قسم السلامة فقط
  DateTime? reviewedAt;

  // ---------------------------------------------------------------------
  // "قسم القبول" — تُعبَّأ فقط عند الموافقة على التصريح، مطابقة لاستمارة
  // "إجراءات ومتطلبات السلامة لتصريح العمل" (نفس أسماء الحقول المستخدَمة في
  // PATCH /safety-permits/:id/review على سيرفر صيانتي المحلي: siteHazards,
  // potentialRisks, ppeRequired, precautions).
  // ---------------------------------------------------------------------
  List<String> siteHazards;
  List<String> potentialRisks;
  List<String> ppeRequired;
  String? precautions; // الإجراءات الإلزامية للتصريح العمل

  // ---------------------------------------------------------------------
  // "قسم الرفض" — يُعبَّأ فقط عند رفض التصريح.
  // ---------------------------------------------------------------------
  String? rejectionReason;

  final DateTime requestedAt;

  SafetyPermit({
    required this.id,
    this.officeName,
    required this.location,
    required this.description,
    required this.workersCount,
    this.responsiblePhone,
    this.operationTypes = const [],
    this.equipmentUsed,
    this.equipmentPhoto,
    this.startAt,
    this.endAt,
    required this.requesterName,
    this.relatedWorkOrderId,
    this.relatedTask,
    this.status = PermitStatus.pending,
    this.reviewedBy,
    this.reviewedAt,
    this.siteHazards = const [],
    this.potentialRisks = const [],
    this.ppeRequired = const [],
    this.precautions,
    this.rejectionReason,
    required this.requestedAt,
  });

  /// يبني تصريحًا من استجابة سيرفر صيانتي المحلي (حقل "permit" في ردود
  /// GET/POST/PATCH /api/safety-permits) — الشكل: صفوف جدول safety_permits
  /// كما هي (snake_case)، راجع routes/safetyPermits.js.
  factory SafetyPermit.fromApi(Map<String, dynamic> d) => SafetyPermit(
        id: d['id'].toString(),
        officeName: d['office_name'] as String?,
        location: (d['location'] as String?) ?? '',
        description: (d['description'] as String?) ?? '',
        workersCount: (d['workers_count'] as num?)?.toInt() ?? 1,
        responsiblePhone: d['responsible_phone'] as String?,
        operationTypes: (d['operation_types'] as List?)?.cast<String>() ?? const [],
        equipmentUsed: d['equipment_used'] as String?,
        equipmentPhoto: d['equipment_photo'] as String?,
        startAt: d['start_at'] != null ? DateTime.tryParse(d['start_at'] as String) : null,
        endAt: d['end_at'] != null ? DateTime.tryParse(d['end_at'] as String) : null,
        requesterName: (d['requested_by'] as String?) ?? '',
        relatedWorkOrderId: d['related_work_order_id']?.toString(),
        relatedTask: d['related_work_order_id'] != null && d['wo_description'] != null
            ? PermitTask(
                id: d['related_work_order_id'].toString(),
                kind: (d['wo_kind'] as String?) ?? 'emergency',
                description: d['wo_description'] as String,
                status: (d['wo_status'] as String?) ?? '',
                equipmentName: d['wo_equipment_name'] as String?,
                equipmentCode: d['wo_equipment_code'] as String?,
                facility: d['wo_facility'] as String?,
                lineName: d['wo_line_name'] as String?,
                createdBy: d['wo_created_by'] as String?,
                createdAt: d['wo_created_at'] != null ? DateTime.tryParse(d['wo_created_at'] as String) : null,
                technicianNames: d['wo_technician_names'] as String?,
              )
            : null,
        status: _statusFromApi(d['status'] as String?),
        reviewedBy: d['reviewed_by'] as String?,
        reviewedAt: d['reviewed_at'] != null ? DateTime.tryParse(d['reviewed_at'] as String) : null,
        siteHazards: (d['site_hazards'] as List?)?.cast<String>() ?? const [],
        potentialRisks: (d['potential_risks'] as List?)?.cast<String>() ?? const [],
        ppeRequired: (d['ppe_required'] as List?)?.cast<String>() ?? const [],
        precautions: d['precautions'] as String?,
        rejectionReason: d['rejection_reason'] as String?,
        requestedAt: DateTime.tryParse((d['requested_at'] as String?) ?? '') ?? DateTime.now(),
      );

  String get operationTypesLabel =>
      operationTypes.isEmpty ? '—' : operationTypes.map((t) => kOperationTypeLabels[t] ?? t).join('، ');
}
