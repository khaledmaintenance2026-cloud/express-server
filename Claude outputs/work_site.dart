/// موقع العمل [WorkSite] — كيان مُدار (بدل نص حر) يُربط اختياريًا بأصناف
/// كتالوج المخزون. راجع جدول work_sites في schema.sql وroutes/inventory.js
/// لشرح دورة الحياة الكاملة على السيرفر — هذا النموذج يعكسه كما هو بلا أي
/// منطق إضافي هنا.

class WorkSite {
  final String id;
  final String name;
  final bool active;
  final String? notes;

  const WorkSite({
    required this.id,
    required this.name,
    required this.active,
    this.notes,
  });

  factory WorkSite.fromApi(Map<String, dynamic> d) => WorkSite(
        id: d['id'].toString(),
        name: (d['name'] as String?) ?? '',
        active: (d['active'] as bool?) ?? true,
        notes: d['notes'] as String?,
      );
}
