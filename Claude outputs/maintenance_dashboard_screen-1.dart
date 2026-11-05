import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../safety/safety_permit_request_screen.dart';
import 'maintenance_assign_screen.dart';
import 'maintenance_completed_screen.dart';
import 'maintenance_edit_screen.dart';
import 'maintenance_incoming_incidents_screen.dart';
import 'maintenance_new_report_screen.dart';
import 'maintenance_report_print_screen.dart';
import 'maintenance_reports_screen.dart';
import 'maintenance_task_close_screen.dart';
import 'maintenance_work_order_screen.dart';

/// تبويبا لوحة الصيانة — "المخزون والقطع" كان تبويبًا ثالثًا هنا لفترة، ثم
/// فُصل ليصير تبويبًا مستقلاً بالتنقل السفلي (راجع inventory_dashboard_screen.dart
/// وmain.dart) بقرار من الإدارة أن لا يبقى محصورًا داخل لوحة الصيانة فقط،
/// فعادت هذه اللوحة لتبويبيها الأصليين فقط.
enum _DashTab { emergency, preventive }

class MaintenanceDashboardScreen extends StatefulWidget {
  const MaintenanceDashboardScreen({super.key});

  @override
  State<MaintenanceDashboardScreen> createState() => _MaintenanceDashboardScreenState();
}

class _MaintenanceDashboardScreenState extends State<MaintenanceDashboardScreen> {
  _DashTab _tab = _DashTab.emergency;

  // الحذف من هنا (لوحة العمل اليومية، أي حالة غير مكتمل) قرار صريح من
  // الإدارة 2026-09-26: كان مقصورًا سابقًا على شاشة "الأعمال المنجزة" فقط —
  // الآن مسؤول الصيانة/المدير يقدر يحذف أي مهمة بأي حالة من هنا مباشرة، بلا
  // فتح شاشة التعديل. نفس نص التأكيد المستخدم في maintenance_completed_screen.dart.
  Future<void> _confirmDelete(String reportId, String title) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف نهائي', style: TextStyle(fontSize: 15)),
        content: Text(
          'سيُحذف "$title" نهائيًا من قاعدة البيانات على السيرفر — يختفي من كل '
          'الأجهزة، ويصل إشعار بذلك لجروب الصيانة والفنيين المُسنَدين. لا يمكن التراجع عن هذا الإجراء.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFB3261E), foregroundColor: Colors.white),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await context.read<AppState>().deleteMaintenanceReport(reportId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم حذف العمل')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر الحذف: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final role = context.watch<AuthService>().currentUser?.role ?? AppRole.maintenanceTechnician;
    final tab = _tab;
    // إنشاء "بلاغ وقائي جديد" (تبويب "أعمال وقائية") قرار صريح من الإدارة:
    // مسؤول الصيانة أو المدير فقط، وليس الفني — راجع نفس القيد الملزم فعليًا
    // على السيرفر في routes/workOrders.js (POST / يرفض kind: 'preventive' من
    // أي دور غير هذين). بلاغ العطل الطارئ (تبويب "الأعطال الطارئة") يبقى
    // متاحًا للفني كما كان دائمًا — لا علاقة له بهذا القيد.
    final canManage = canManageMaintenance(role);
    // الأعمال المنجزة لا تظهر في لوحة العمل اليومية هذه حتى لا تتراكم فيها
    // للأبد — تبقى متاحة (وقابلة للحذف نهائيًا) من شاشة "الأعمال المنجزة"
    // التي يفتحها زر شريط الأدوات بالأسفل.
    final reports = state.maintenanceReports
        .where((r) => (tab == _DashTab.emergency ? r.isEmergency : !r.isEmergency) && r.status != MaintenanceStatus.completed)
        .toList();

    final now = DateTime.now();
    final completedThisMonth = state.maintenanceReports.where((r) =>
        r.status == MaintenanceStatus.completed &&
        r.closedAt != null &&
        r.closedAt!.year == now.year &&
        r.closedAt!.month == now.month).length;
    final preventiveCount = state.maintenanceReports.where((r) => !r.isEmergency).length;
    final total = state.maintenanceReports.isEmpty ? 1 : state.maintenanceReports.length;
    final preventiveRatio = ((preventiveCount / total) * 100).round();
    final avgResolution = averageMaintenanceResolution(state.maintenanceReports);
    final avgResolutionLabel = avgResolution == null ? '—' : ArabicFormat.duration(avgResolution);

    final incomingIncidentsCount = state.incidents.where((i) => i.isOpen).length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('الصيانة', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        actions: [
                // بلاغات إنتاج وصلت للتو ولم تتحوّل بعد إلى أمر عمل — راجع
                // maintenance_incoming_incidents_screen.dart. الرقم يعكس فورًا أي
                // بلاغ جديد يصل عبر الاستطلاع الدوري (نفس آلية جرس الإشعارات).
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.move_to_inbox_outlined),
                      tooltip: 'بلاغات إنتاج بانتظار التحويل',
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const MaintenanceIncomingIncidentsScreen()),
                      ),
                    ),
                    if (incomingIncidentsCount > 0)
                      Positioned(
                        top: 6,
                        right: 6,
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(color: const Color(0xFFB3261E), borderRadius: BorderRadius.circular(999)),
                          child: Text(
                            ArabicFormat.number(incomingIncidentsCount),
                            style: const TextStyle(color: Colors.white, fontSize: 10.5, fontWeight: FontWeight.bold),
                          ),
                        ),
                      ),
                  ],
                ),
                // طلب تصريح عمل (لأعمال خطرة كاللحام/الأماكن المغلقة/الارتفاعات...)
                // — نفس شاشة/عملية الطلب المستخدمة أصلًا من قسم السلامة تمامًا
                // (SafetyPermitRequestScreen)، بلا أي تعديل عليها: المسار على
                // السيرفر (POST /api/safety-permits) لم يكن مقيّدًا بقسم مُعيَّن
                // أصلًا (أي مستخدم مسجَّل دخول يقدر يطلب)، وحتى خيار "ربط بعملية
                // بلاغ قائمة" داخل الشاشة يعرض أوامر عمل الصيانة المفتوحة نفسها —
                // كان ناقصًا فقط زر يفتحها من قسم الصيانة. الطلب يصل لقسم السلامة
                // للمراجعة والاعتماد كالمعتاد، ولا علاقة لقسم الصيانة بالموافقة عليه.
                IconButton(
                  icon: const Icon(Icons.verified_user_outlined),
                  tooltip: 'طلب تصريح عمل',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const SafetyPermitRequestScreen()),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.task_alt_outlined),
                  tooltip: 'الأعمال المنجزة',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const MaintenanceCompletedScreen()),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.description_outlined),
                  tooltip: 'التقارير',
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const MaintenanceReportsScreen()),
                  ),
                ),
              ],
      ),
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    KpiCard(value: avgResolutionLabel, label: 'متوسط وقت الإصلاح', valueColor: AppColors.maintenance),
                    const SizedBox(width: 10),
                    KpiCard(value: ArabicFormat.number(completedThisMonth), label: 'أعطال هذا الشهر', valueColor: AppColors.maintenance),
                    const SizedBox(width: 10),
                    KpiCard(value: '٪${ArabicFormat.toEasternDigits(preventiveRatio)}', label: 'نسبة الوقائي', valueColor: AppColors.maintenance),
                  ],
                ),
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(12)),
                  child: Row(
                    children: [
                      Expanded(child: _Segment(label: 'الأعطال الطارئة', selected: tab == _DashTab.emergency, onTap: () => setState(() => _tab = _DashTab.emergency))),
                      Expanded(child: _Segment(label: 'أعمال وقائية', selected: tab == _DashTab.preventive, onTap: () => setState(() => _tab = _DashTab.preventive))),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Expanded(
                  child: reports.isEmpty
                      ? const Center(child: Text('لا توجد بلاغات جارية', style: TextStyle(color: AppColors.textMuted)))
                      : ListView.separated(
                          itemCount: reports.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 10),
                          itemBuilder: (context, i) {
                            final r = reports[i];
                            return MaintenanceReportCard(
                              report: r,
                              onEdit: canManage
                                  ? () => Navigator.of(context).push(
                                        MaterialPageRoute(builder: (_) => MaintenanceEditScreen(report: r)),
                                      )
                                  : null,
                              onDelete: canManage ? () => _confirmDelete(r.id, '${r.equipment} — ${r.line}') : null,
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
          // زر الإضافة (+) يظهر دائمًا لتبويب "الأعطال الطارئة"، لكن لا يظهر
          // إطلاقًا لتبويب "أعمال وقائية" إلا لمسؤول الصيانة أو المدير —
          // بدل إظهاره ثم رفض السيرفر الطلب برسالة خطأ بعد الضغط عليه.
          if (tab == _DashTab.emergency || canManage)
            Positioned(
              bottom: 20,
              left: 20,
              child: FloatingActionButton(
                backgroundColor: AppColors.maintenance,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => tab == _DashTab.emergency ? const MaintenanceNewReportScreen() : const MaintenanceWorkOrderScreen(),
                  ),
                ),
                child: const Icon(Icons.add, color: Colors.white),
              ),
            ),
        ],
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _Segment({required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          boxShadow: selected ? [BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 3)] : null,
        ),
        alignment: Alignment.center,
        child: Text(
          label,
          style: TextStyle(
            fontSize: 14,
            fontWeight: selected ? FontWeight.bold : FontWeight.w600,
            color: selected ? AppColors.maintenance : AppColors.textMuted,
          ),
        ),
      ),
    );
  }
}

/// بطاقة عرض بلاغ/أمر عمل صيانة — مستخدمة في لوحة العمل اليومية وفي شاشة
/// الأعمال المنجزة (maintenance_completed_screen.dart) معًا. تمرير [onDelete]
/// يضيف زر حذف نهائي للبطاقة (كان يُستخدم فقط للأعمال المنجزة المؤرشفة، ثم
/// صار متاحًا أيضًا للوحة العمل اليومية بأي حالة — قرار 2026-09-26). تمرير
/// [onEdit] يضيف زر "تعديل" (قلم) يفتح شاشة تعديل المهمة — لمسؤول
/// الصيانة/المدير فقط، مطابقةً لقيد السيرفر (requireRole('maintenance_manager')).
class MaintenanceReportCard extends StatelessWidget {
  final MaintenanceReport report;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;

  const MaintenanceReportCard({super.key, required this.report, this.onEdit, this.onDelete});

  @override
  Widget build(BuildContext context) {
    final statusInfo = switch (report.status) {
      MaintenanceStatus.pendingAssignment => (
          label: 'بانتظار التعيين',
          color: AppColors.warningText,
          bg: AppColors.warningBg,
        ),
      MaintenanceStatus.inProgress => (
          label: 'قيد التنفيذ',
          color: AppColors.maintenance,
          bg: AppColors.maintenance.withOpacity(0.1),
        ),
      MaintenanceStatus.completed => (
          label: 'مكتمل',
          color: AppColors.successText,
          bg: AppColors.successBg,
        ),
    };

    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: () {
        if (report.status == MaintenanceStatus.pendingAssignment) {
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => MaintenanceAssignScreen(report: report)));
        } else if (report.status == MaintenanceStatus.inProgress) {
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => MaintenanceTaskCloseScreen(report: report)));
        } else if (report.status == MaintenanceStatus.completed) {
          Navigator.of(context).push(MaterialPageRoute(builder: (_) => MaintenanceReportPrintScreen(report: report)));
        }
      },
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${report.equipment} — ${report.line}',
                      style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
                ),
                if (report.status == MaintenanceStatus.completed)
                  const Padding(
                    padding: EdgeInsets.only(left: 6),
                    child: Icon(Icons.picture_as_pdf_outlined, size: 18, color: AppColors.textMuted),
                  ),
                // إضافة فني إضافي لبلاغ قيد التنفيذ (سبق تعيين فني له) — بلا
                // فتح شاشة "إغلاق البلاغ" كاملة؛ نفس شاشة التعيين تُستخدم هنا
                // أيضًا وتضيف فقط بلا مساس بالفني/الفنيين المُسندين حاليًا.
                if (report.status == MaintenanceStatus.inProgress)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: InkWell(
                      onTap: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => MaintenanceAssignScreen(report: report)),
                      ),
                      borderRadius: BorderRadius.circular(8),
                      child: const Padding(
                        padding: EdgeInsets.all(2),
                        child: Icon(Icons.person_add_alt_1_outlined, size: 18, color: AppColors.maintenance),
                      ),
                    ),
                  ),
                if (onEdit != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: InkWell(
                      onTap: onEdit,
                      borderRadius: BorderRadius.circular(8),
                      child: const Padding(
                        padding: EdgeInsets.all(2),
                        child: Icon(Icons.edit_outlined, size: 18, color: AppColors.maintenance),
                      ),
                    ),
                  ),
                StatusPill(label: statusInfo.label, color: statusInfo.color, background: statusInfo.bg),
                if (onDelete != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: InkWell(
                      onTap: onDelete,
                      borderRadius: BorderRadius.circular(8),
                      child: const Padding(
                        padding: EdgeInsets.all(2),
                        child: Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(report.description, style: const TextStyle(fontSize: 13, color: AppColors.textSecondary)),
            // اسم/أسماء الفنيين المُسنَدين — قرار صريح 2026-09-26: يظهر لكل من
            // يرى البطاقة أصلًا (فني مُسنَد لها أو مسؤول/مدير)، ليعرف الفني من
            // يشاركه المهمة. لا يظهر شيء طالما "بانتظار التعيين" (لا فني بعد).
            if (report.technicianDisplayNames != '—') ...[
              const SizedBox(height: 4),
              Text('الفنيون: ${report.technicianDisplayNames}',
                  style: const TextStyle(fontSize: 12, color: AppColors.textMuted, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 6),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(_timeAgo(report.reportedAt), style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                Text('رفع: ${report.reportedBy}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _timeAgo(DateTime dt) {
    final diff = DateTime.now().difference(dt);
    if (diff.inDays >= 1) return 'قبل ${ArabicFormat.number(diff.inDays)} يوم';
    if (diff.inHours >= 1) return 'منذ ${ArabicFormat.number(diff.inHours)} ساعة';
    return 'منذ ${ArabicFormat.number(diff.inMinutes)} دقيقة';
  }
}
