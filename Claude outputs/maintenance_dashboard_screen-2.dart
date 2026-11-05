import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../safety/safety_permit_request_screen.dart';
import 'maintenance_assign_screen.dart';
import 'maintenance_completed_screen.dart';
import 'maintenance_edit_screen.dart';
import 'maintenance_new_report_screen.dart';
import 'maintenance_report_print_screen.dart';
import 'maintenance_reports_screen.dart';
import 'maintenance_task_close_screen.dart';
import 'maintenance_work_order_screen.dart';

/// تبويبا لوحة الصيانة — "المخزون والقطع" كان تبويبًا ثالثًا هنا لفترة، ثم
/// فُصل ليصير تبويبًا مستقلاً بالتنقل السفلي (راجع inventory_dashboard_screen.dart
/// وmain.dart) بقرار من الإدارة أن لا يبقى محصورًا داخل لوحة الصيانة فقط،
/// فعادت هذه اللوحة لتبويبيها الأصليين فقط.
///
/// أُضيف تبويب ثالث "المهام العامة" (طلب 2026-10-01): كانت "مهام العمل"
/// (توصيل، نقل معدات، أعمال إدارية... — راجع isTask في MaintenanceReport)
/// تظهر مختلطة داخل تبويب "الأعطال الطارئة" نفسه (لأن kind تبقى 'emergency'
/// على السيرفر عمدًا)، فصار لها تبويبها الخاص هنا فقط للعرض — بلا أي تغيير
/// في كود السيرفر أو في kind المخزّنة فعليًا.
///
/// كما صار تبويب "الأعطال الطارئة" يعرض الآن بلاغات الإنتاج التي لم تتحوّل
/// بعد لأمر عمل (كانت سابقًا في شاشة منفصلة "بلاغات إنتاج بانتظار التحويل"
/// تُفتح من أيقونة بالأعلى) ضمن نفس القائمة مباشرة، بلا أي خطوة/شاشة إضافية
/// لمجرد رؤيتها — بطاقة مختلفة الشكل والألوان (IncomingIncidentCard، بالأخضر
/// المطفي لون قسم الإنتاج) ومكتوب عليها "بلاغ إنتاج" للتفريق البصري الفوري
/// عن بطاقة أمر عمل فعلي (MaintenanceReportCard)، مع بقاء زر "تحويل" مباشرة
/// على البطاقة نفسها لمن يريد تحويلها فعليًا لأمر عمل.
enum _DashTab { emergency, preventive, tasks }

class MaintenanceDashboardScreen extends StatefulWidget {
  const MaintenanceDashboardScreen({super.key});

  @override
  State<MaintenanceDashboardScreen> createState() => _MaintenanceDashboardScreenState();
}

class _MaintenanceDashboardScreenState extends State<MaintenanceDashboardScreen> {
  _DashTab _tab = _DashTab.emergency;
  final Set<String> _convertingIncidentIds = {};

  @override
  void initState() {
    super.initState();
    // بلاغات الإنتاج المعلّقة وملخص الأرقام السريع (أكثر عطل تكرارًا/أعلى
    // فني أداءً) لم يكونا يُحمَّلان تلقائيًا عند فتح لوحة الصيانة نفسها —
    // الأول كان يُحمَّل فقط عند فتح الشاشة المنفصلة القديمة، والثاني لم يكن
    // مستخدَمًا من أي شاشة إطلاقًا. نحمّلهما هنا الآن ليظهرا فورًا بلا أي
    // تنقل إضافي.
    Future.microtask(() {
      final state = context.read<AppState>();
      state.reloadIncidents();
      state.reloadMaintenanceQuickStats();
    });
  }

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

  /// تحويل بلاغ إنتاج (لم يتحوّل بعد لأمر عمل) إلى أمر عمل صيانة طارئ حقيقي
  /// — نفس منطق الشاشة القديمة "بلاغات إنتاج بانتظار التحويل" بالضبط (راجع
  /// AppState.convertIncidentToWorkOrder)، يُستدعى الآن من زر "تحويل" على
  /// بطاقة البلاغ مباشرة ضمن تبويب "الأعطال الطارئة" نفسه.
  Future<void> _convertIncident(Incident incident) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تحويل إلى أمر عمل؟'),
        content: const Text('سيُنشأ أمر عمل صيانة طارئ من هذا البلاغ، ويصبح بانتظار تعيين فني له.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('تحويل')),
        ],
      ),
    );
    if (ok != true || !mounted) return;

    setState(() => _convertingIncidentIds.add(incident.id));
    try {
      await appState.convertIncidentToWorkOrder(incident);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم التحويل — عيّن فنيًا له من هذه القائمة')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر التحويل: $e')),
      );
    } finally {
      if (mounted) setState(() => _convertingIncidentIds.remove(incident.id));
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
    // أي دور غير هذين).
    final canManage = canManageMaintenance(role);

    // الأعمال المنجزة لا تظهر في لوحة العمل اليومية هذه حتى لا تتراكم فيها
    // للأبد — تبقى متاحة (وقابلة للحذف نهائيًا) من شاشة "الأعمال المنجزة"
    // التي يفتحها زر شريط الأدوات بالأسفل.
    final openReports = state.maintenanceReports.where((r) => r.status != MaintenanceStatus.completed);

    // عناصر التبويب الحالي — قائمة موحّدة قد تحوي أوامر عمل (MaintenanceReport)
    // وبلاغات إنتاج لم تتحوّل بعد (Incident) معًا في تبويب "الأعطال الطارئة"
    // فقط، مرتّبة زمنيًا (الأحدث أولًا) كأنها قائمة واحدة فعلية.
    final List<Object> feedItems = switch (tab) {
      _DashTab.emergency => [
          ...openReports.where((r) => r.isEmergency && !r.isTask),
          ...state.incidents.where((i) => i.isOpen),
        ]..sort((a, b) => _feedTime(b).compareTo(_feedTime(a))),
      _DashTab.preventive => openReports.where((r) => !r.isEmergency).toList(),
      _DashTab.tasks => openReports.where((r) => r.isTask).toList(),
    };

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

    // ملخص أرقام سريع إضافي (أكثر عطل تكرارًا + الفني الأعلى أداءً خلال آخر
    // ٣٠ يومًا) — من GET /api/dashboard، يظهر فقط لو توفّرت بيانات كافية
    // (مصنع جديد بلا سجل كافٍ مثلًا لن يظهر له هذا السطر، بلا أي خطأ).
    final quickStats = state.maintenanceQuickStats;
    final quickStatsParts = <String>[];
    if (quickStats != null) {
      if (quickStats.topFaultDescription != null && quickStats.topFaultOccurrences > 0) {
        quickStatsParts.add(
          'الأكثر تكرارًا (٣٠ يوم): ${quickStats.topFaultDescription} (${ArabicFormat.number(quickStats.topFaultOccurrences)} مرات)',
        );
      }
      if (quickStats.topTechnicianName != null && quickStats.topTechnicianCompletedCount > 0) {
        quickStatsParts.add(
          'الأعلى أداءً: ${quickStats.topTechnicianName} (${ArabicFormat.number(quickStats.topTechnicianCompletedCount)} منجز)',
        );
      }
    }
    final quickStatsLine = quickStatsParts.isEmpty ? null : quickStatsParts.join('  ·  ');

    // زر "+" مختلف حسب التبويب: "مهام عامة" يفتح إنشاء مهمة عمل لأي دور
    // صيانة (كما كان على تبويب "الأعطال الطارئة" سابقًا قبل فصل المهام في
    // تبويبها الخاص)، "أعمال وقائية" لمسؤول الصيانة/المدير فقط كما كان
    // تمامًا. تبويب "الأعطال الطارئة" بلا زر إضافة إطلاقًا الآن — لا توجد
    // طريقة لرفع عطل طارئ مباشرة من هنا أصلًا (يصل فقط كبلاغ إنتاج يُحوَّل
    // أو يُستحدث عبر "مهمة عمل")، فيبقى التبويب للعرض/التحويل فقط.
    Widget? fab;
    if (tab == _DashTab.tasks) {
      fab = FloatingActionButton(
        backgroundColor: AppColors.maintenance,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const MaintenanceNewReportScreen()),
        ),
        child: const Icon(Icons.add, color: Colors.white),
      );
    } else if (tab == _DashTab.preventive && canManage) {
      fab = FloatingActionButton(
        backgroundColor: AppColors.maintenance,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute(builder: (_) => const MaintenanceWorkOrderScreen()),
        ),
        child: const Icon(Icons.add, color: Colors.white),
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('الصيانة', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
        actions: [
          // طلب تصريح عمل (لأعمال خطرة كاللحام/الأماكن المغلقة/الارتفاعات...)
          // — نفس شاشة/عملية الطلب المستخدمة أصلًا من قسم السلامة تمامًا
          // (SafetyPermitRequestScreen)، بلا أي تعديل عليها.
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
                if (quickStatsLine != null) ...[
                  const SizedBox(height: 10),
                  InfoNote(text: quickStatsLine, color: AppColors.maintenance, icon: Icons.insights_outlined),
                ],
                const SizedBox(height: 14),
                Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(12)),
                  child: Row(
                    children: [
                      Expanded(child: _Segment(label: 'الأعطال الطارئة', selected: tab == _DashTab.emergency, onTap: () => setState(() => _tab = _DashTab.emergency))),
                      Expanded(child: _Segment(label: 'أعمال وقائية', selected: tab == _DashTab.preventive, onTap: () => setState(() => _tab = _DashTab.preventive))),
                      Expanded(child: _Segment(label: 'المهام العامة', selected: tab == _DashTab.tasks, onTap: () => setState(() => _tab = _DashTab.tasks))),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
                Expanded(
                  child: feedItems.isEmpty
                      ? const Center(child: Text('لا توجد بلاغات جارية', style: TextStyle(color: AppColors.textMuted)))
                      : ListView.separated(
                          itemCount: feedItems.length,
                          separatorBuilder: (_, __) => const SizedBox(height: 10),
                          itemBuilder: (context, i) {
                            final item = feedItems[i];
                            if (item is Incident) {
                              return IncomingIncidentCard(
                                incident: item,
                                converting: _convertingIncidentIds.contains(item.id),
                                onConvert: () => _convertIncident(item),
                              );
                            }
                            final r = item as MaintenanceReport;
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
          if (fab != null)
            Positioned(
              bottom: 20,
              left: 20,
              child: fab,
            ),
        ],
      ),
    );
  }
}

/// وقت العنصر — [MaintenanceReport.reportedAt] أو [Incident.reportedAt] —
/// يُستخدم فقط لترتيب القائمة المدمجة في تبويب "الأعطال الطارئة" زمنيًا.
DateTime _feedTime(Object item) {
  if (item is Incident) return item.reportedAt;
  return (item as MaintenanceReport).reportedAt;
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
        padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 2),
        decoration: BoxDecoration(
          color: selected ? AppColors.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          boxShadow: selected ? [BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 3)] : null,
        ),
        alignment: Alignment.center,
        child: Text(
          label,
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 12.5,
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

/// بطاقة "بلاغ إنتاج" لم يتحوّل بعد لأمر عمل صيانة — تظهر الآن مباشرة ضمن
/// قائمة تبويب "الأعطال الطارئة" باللوحة الرئيسية (طلب 2026-10-01: "بدون أمر
/// تحويل تنزل بنفس قائمة الأعمال")، بشكل وألوان مختلفة عمدًا عن
/// [MaintenanceReportCard] (الأخضر المطفي — لون قسم الإنتاج نفسه في باقي
/// التطبيق — بدل الكحلي، + وسم "بلاغ إنتاج" صريح بالأعلى) حتى يُفرَّق
/// المستخدم فورًا بين بلاغ لم يتحوّل بعد (لا فني مُسنَد، لا حالة عمل حقيقية)
/// وأمر عمل فعلي قائم. زر "تحويل" يبقى متاحًا على البطاقة نفسها لمن يريد
/// تحويلها الآن؛ بلا تحويل، تبقى ظاهرة هنا فقط للعِلم.
class IncomingIncidentCard extends StatelessWidget {
  final Incident incident;
  final bool converting;
  final VoidCallback onConvert;

  const IncomingIncidentCard({super.key, required this.incident, required this.converting, required this.onConvert});

  @override
  Widget build(BuildContext context) {
    final locationLabel = [
      if (incident.lineName != null) incident.lineName!,
      if (incident.facility != null) incident.facility!,
    ].join(' — ');

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.production.withOpacity(0.07),
        border: Border.all(color: AppColors.production.withOpacity(0.35)),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const StatusPill(label: 'بلاغ إنتاج', color: Colors.white, background: AppColors.production),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  locationLabel.isEmpty ? 'بدون خط محدد' : locationLabel,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (incident.severityLabel != null) ...[
                const SizedBox(width: 6),
                StatusPill(label: incident.severityLabel!, color: AppColors.textSecondary, background: AppColors.divider),
              ],
            ],
          ),
          const SizedBox(height: 8),
          if (incident.equipmentName != null) ...[
            Text(incident.equipmentName!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
            const SizedBox(height: 4),
          ],
          Text(incident.description, style: const TextStyle(fontSize: 13.5)),
          if (incident.expectedBatchNumber != null && incident.expectedBatchNumber!.isNotEmpty) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: AppColors.maintenance.withOpacity(0.1),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                'الباتش المتوقع: ${incident.expectedBatchNumber}',
                style: const TextStyle(fontSize: 11, color: AppColors.maintenance, fontWeight: FontWeight.w600),
              ),
            ),
          ],
          if (incident.photoPath != null) ...[
            const SizedBox(height: 8),
            PhotoThumbnailButton(url: '$kApiOrigin${incident.photoPath}'),
          ],
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Text(
                  'بلّغ: ${incident.reportedBy} — توقف: ${ArabicFormat.duration(Duration(minutes: incident.downtimeMinutes))}',
                  style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const SizedBox(width: 8),
              converting
                  ? const Padding(
                      padding: EdgeInsets.all(4),
                      child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2)),
                    )
                  : TextButton.icon(
                      onPressed: onConvert,
                      icon: const Icon(Icons.build_circle_outlined, size: 16),
                      label: const Text('تحويل', style: TextStyle(fontSize: 12.5)),
                      style: TextButton.styleFrom(
                        foregroundColor: AppColors.production,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: Size.zero,
                      ),
                    ),
            ],
          ),
        ],
      ),
    );
  }
}
