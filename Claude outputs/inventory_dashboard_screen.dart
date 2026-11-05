import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../services/api_client.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import 'inventory_movements_screen.dart';
import 'inventory_screen.dart';
import 'inventory_suppliers_screen.dart';
import 'inventory_work_sites_screen.dart';

/// الحاوية المستقلة لقسم "المخزون والقطع" — تبويب قائم بذاته بالتنقل السفلي
/// (راجع main.dart وhome_screen.dart)، منفصل تمامًا عن لوحة الصيانة
/// (maintenance_dashboard_screen.dart) رغم أن الوصول له يبقى مقصورًا على
/// فريق الصيانة والمخزون فقط (فني/مسؤول صيانة، مسؤول المخزون، المصمم) —
/// قرار صريح من الإدارة. المحتوى الفعلي كله داخل [InventorySection]
/// (inventory_screen.dart) القابل للتضمين أصلًا؛ هذه الشاشة تضيف فقط
/// Scaffold/AppBar مستقلين بهوية بصرية خاصة (AppColors.inventory) بدل
/// الاعتماد على AppBar لوحة الصيانة كما كان سابقًا، بالإضافة لقائمة "المزيد"
/// التي تفتح الشاشات الفرعية الثلاث (سجل الحركة، الموردون، مواقع العمل)
/// وخيار تصدير CSV.
class InventoryDashboardScreen extends StatelessWidget {
  const InventoryDashboardScreen({super.key});

  Future<void> _exportCsv(BuildContext context, String type) async {
    final token = ApiClient.instance.token;
    if (token == null) return;
    final uri = Uri.parse('$kApiBaseUrl/inventory/export.csv').replace(queryParameters: {'type': type, 'token': token});
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تعذّر فتح رابط التصدير')));
    }
  }

  Future<void> _openExportDialog(BuildContext context) async {
    final type = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تصدير المخزون (CSV)'),
        content: const Text('يفتح الملف في متصفح خارجي ليقدر يُحفَظ مباشرة — نفس طريقة "تنزيل الصورة" في التطبيق.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop('movements'), child: const Text('سجل الحركة')),
          TextButton(onPressed: () => Navigator.of(ctx).pop('items'), child: const Text('كتالوج الأصناف')),
        ],
      ),
    );
    if (type != null && context.mounted) await _exportCsv(context, type);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('المخزون والقطع', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        actions: [
          IconButton(
            tooltip: 'تصدير CSV',
            icon: const Icon(Icons.download_outlined),
            onPressed: () => _openExportDialog(context),
          ),
          PopupMenuButton<Widget>(
            tooltip: 'المزيد',
            icon: const Icon(Icons.more_vert),
            onSelected: (screen) => Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen)),
            itemBuilder: (context) => const [
              PopupMenuItem(value: InventoryMovementsScreen(), child: Text('سجل حركة المخزون')),
              PopupMenuItem(value: InventorySuppliersScreen(), child: Text('الموردون')),
              PopupMenuItem(value: InventoryWorkSitesScreen(), child: Text('مواقع العمل')),
            ],
          ),
        ],
      ),
      body: const Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: InventorySection(),
      ),
    );
  }
}
