/// المورّد [Supplier] — سجل مستقل (اسم، جهة اتصال، هاتف، بريد، عنوان،
/// نشط/غير نشط) يُربط اختياريًا بأصناف كتالوج المخزون. راجع جدول suppliers
/// في schema.sql وroutes/inventory.js لشرح دورة الحياة الكاملة على السيرفر —
/// هذا النموذج يعكسه كما هو بلا أي منطق إضافي هنا.

class Supplier {
  final String id;
  final String name;
  final String? contactName;
  final String? phone;
  final String? email;
  final String? address;
  final bool active;
  final String? notes;

  const Supplier({
    required this.id,
    required this.name,
    this.contactName,
    this.phone,
    this.email,
    this.address,
    required this.active,
    this.notes,
  });

  factory Supplier.fromApi(Map<String, dynamic> d) => Supplier(
        id: d['id'].toString(),
        name: (d['name'] as String?) ?? '',
        contactName: d['contact_name'] as String?,
        phone: d['phone'] as String?,
        email: d['email'] as String?,
        address: d['address'] as String?,
        active: (d['active'] as bool?) ?? true,
        notes: d['notes'] as String?,
      );
}
