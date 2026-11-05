/// نموذج "العهدة" — عدة ومعدات (دريل، إلخ) تُسلَّم لفني وتُرجَع لاحقًا، بعكس
/// [PartRequest] في inventory.dart (يُصرف ولا يرجع). كل عدة صف كتالوج مستقل
/// بحالته الخاصة (متاحة/بعهدة) — لا "كمية" هنا. راجع routes/custody.js
/// وschema.sql (جدولا custody_items وcustody_assignments) لشرح دورة الحالة
/// الكاملة قبل تعديل هذا الملف.
///
/// استجابة GET /api/custody/items تدمج بيانات آخر تسليم مفتوح (إن وُجد)
/// مباشرة مع صف العدة نفسه (current*) — لا حاجة لتحميل سجل التسليمات كاملًا
/// فقط لعرض شاشة الكتالوج الرئيسية.
class CustodyItem {
  final String id;
  final String name;
  final String? category;
  final String? code;
  final String? notes;
  final String status; // 'available' | 'assigned'

  final String? currentAssignmentId;
  final String? currentHolder;
  final DateTime? currentAssignedAt;
  final DateTime? currentExpectedReturnAt;
  final String? currentWorkOrderDescription;

  const CustodyItem({
    required this.id,
    required this.name,
    this.category,
    this.code,
    this.notes,
    required this.status,
    this.currentAssignmentId,
    this.currentHolder,
    this.currentAssignedAt,
    this.currentExpectedReturnAt,
    this.currentWorkOrderDescription,
  });

  bool get isAssigned => status == 'assigned';

  /// متأخرة عن موعد الإرجاع المتوقع — لا تعني بالضرورة مشكلة (الموعد
  /// اختياري أصلًا)، فقط تنبيه بصري في الشاشة.
  bool get isOverdue =>
      isAssigned && currentExpectedReturnAt != null && currentExpectedReturnAt!.isBefore(DateTime.now());

  factory CustodyItem.fromApi(Map<String, dynamic> d) => CustodyItem(
        id: d['id'].toString(),
        name: (d['name'] as String?) ?? '',
        category: d['category'] as String?,
        code: d['code'] as String?,
        notes: d['notes'] as String?,
        status: (d['status'] as String?) ?? 'available',
        currentAssignmentId: d['current_assignment_id']?.toString(),
        currentHolder: d['current_holder'] as String?,
        currentAssignedAt: d['current_assigned_at'] == null ? null : DateTime.tryParse(d['current_assigned_at'].toString()),
        currentExpectedReturnAt:
            d['current_expected_return_at'] == null ? null : DateTime.tryParse(d['current_expected_return_at'].toString()),
        currentWorkOrderDescription: d['current_work_order_description'] as String?,
      );
}

/// سجل تسليم/استرجاع واحد — تُستخدم فقط لحظة الإرجاع (نحتاج معرّف السجل
/// المرتبط بـ[CustodyItem.currentAssignmentId])، والشاشة الرئيسية تعتمد على
/// الحقول current* المدموجة في [CustodyItem] نفسه بدل تحميل قائمة منفصلة.
class CustodyAssignment {
  final String id;
  final String itemId;
  final String? itemName;
  final String assignedTo;
  final String assignedBy;
  final DateTime assignedAt;
  final DateTime? expectedReturnAt;
  final String? notes;
  final DateTime? returnedAt;
  final String? returnNotes;

  const CustodyAssignment({
    required this.id,
    required this.itemId,
    this.itemName,
    required this.assignedTo,
    required this.assignedBy,
    required this.assignedAt,
    this.expectedReturnAt,
    this.notes,
    this.returnedAt,
    this.returnNotes,
  });

  factory CustodyAssignment.fromApi(Map<String, dynamic> d) => CustodyAssignment(
        id: d['id'].toString(),
        itemId: d['item_id'].toString(),
        itemName: d['item_name'] as String?,
        assignedTo: (d['assigned_to'] as String?) ?? '',
        assignedBy: (d['assigned_by'] as String?) ?? '',
        assignedAt: DateTime.tryParse(d['assigned_at']?.toString() ?? '') ?? DateTime.now(),
        expectedReturnAt: d['expected_return_at'] == null ? null : DateTime.tryParse(d['expected_return_at'].toString()),
        notes: d['notes'] as String?,
        returnedAt: d['returned_at'] == null ? null : DateTime.tryParse(d['returned_at'].toString()),
        returnNotes: d['return_notes'] as String?,
      );
}
