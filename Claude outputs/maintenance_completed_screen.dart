import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'maintenance_analysis_screen.dart';

/// شاشة تقارير الصيانة — كانت بالكامل شاشة عرض ثابتة (أرقام وهمية مكتوبة
/// مباشرة بالكود، وزر "إنشاء التقرير" يعرض رسالة نجاح مزيّفة بدون أي اتصال
/// فعلي بالسيرفر). الآن كل شيء هنا حقيقي: الأرقام محسوبة من بلاغات/أوامر
/// الصيانة الفعلية، والتقرير المخصّص يُنشئ ملفًا حقيقيًا ويُرسل رابطه عبر
/// واتساب لرقم طالبه — بنفس نمط تقارير الإنتاج تمامًا (راجع
/// production_reports_screen.dart).
class MaintenanceReportsScreen extends StatefulWidget {
  const MaintenanceReportsScreen({super.key});

  @override
  State<MaintenanceReportsScreen> createState() => _MaintenanceReportsScreenState();
}

class _MaintenanceReportsScreenState extends State<MaintenanceReportsScreen> {
  DateTimeRange? _selectedRange;
  bool _requestingReport = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadWorkOrders());
  }

  // نتجنّب عمدًا تمرير locale عربي لـ showDateRangePicker — راجع نفس الملاحظة
  // في production_reports_screen.dart.
  Future<void> _pickRange() async {
    final now = DateTime.now();
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: now,
      initialDateRange: _selectedRange ?? DateTimeRange(start: now.subtract(const Duration(days: 30)), end: now),
    );
    if (range != null) setState(() => _selectedRange = range);
  }

  Future<void> _sendReport() async {
    final range = _selectedRange;
    if (range == null) return;
    setState(() => _requestingReport = true);
    try {
      final to = DateTime(range.end.year, range.end.month, range.end.day, 23, 59, 59);
      final result = await context.read<AppState>().requestMaintenanceReport(from: range.start, to: to);
      if (!mounted) return;
      if (result.whatsappSent) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تم إنشاء التقرير وإرساله على واتساب رقمك')),
        );
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('${result.warning ?? 'تعذّر إرسال واتساب تلقائيًا'}\n${result.reportUrl}'),
            duration: const Duration(seconds: 8),
          ),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر إنشاء التقرير: $e')),
      );
    } finally {
      if (mounted) setState(() => _requestingReport = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    // "طلب تقرير بمدة مخصّصة" قرار صريح من الإدارة: مسؤول الصيانة أو المدير
    // فقط، لا الفني — بنفس نمط canManageBatches في production_reports_screen.dart
    // تمامًا، وبنفس القيد الملزم فعليًا على السيرفر
    // (requireRole('maintenance_manager') على POST /api/work-orders/reports/request).
    final canManage = canManageMaintenance(context.watch<AuthService>().currentUser?.role ?? AppRole.maintenanceTechnician);
    final reports = state.maintenanceReports;
    final completedPreventive = reports.where((r) => !r.isEmergency && r.status == MaintenanceStatus.completed).length;
    final avgResolution = averageMaintenanceResolution(reports);
    final avgResolutionLabel = avgResolution == null ? '—' : ArabicFormat.duration(avgResolution);

    return Scaffold(
      appBar: const ScreenTopBar(title: 'تقارير الصيانة'),
      body: RefreshIndicator(
        onRefresh: () => state.reloadWorkOrders(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: ListView(
            children: [
              if (state.workOrdersError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: InfoNote(text: state.workOrdersError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ),
              Row(
                children: [
                  KpiCard(value: ArabicFormat.number(reports.length), label: 'إجمالي البلاغات', valueColor: AppColors.maintenance),
                  const SizedBox(width: 10),
                  KpiCard(value: avgResolutionLabel, label: 'متوسط وقت الإصلاح', valueColor: AppColors.maintenance),
                  const SizedBox(width: 10),
                  KpiCard(value: ArabicFormat.number(completedPreventive), label: 'وقائي منجز', valueColor: AppColors.production),
                ],
              ),
              const SizedBox(height: 20),
              const Text('تقارير تلقائية عبر واتساب', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 10),
              const _ReportRow(title: 'التقرير الشهري', subtitle: 'رابط تقرير — كل ٣٠ يومًا تقريبًا لجروب الصيانة'),
              const SizedBox(height: 10),
              const _ReportRow(title: 'التقرير السنوي', subtitle: 'رابط تقرير — كل سنة تقريبًا لجروب الصيانة'),
              // اختصار مباشر لصفحة "تحليل الصيانة" (رسوم بيانية تفصيلية عن
              // المهام وأداء الفنيين) — طلب صريح 2026-10-03: "إضافتها
              // للتقارير أيضًا"، بنفس قيد canManage المستخدم فوق لباقي هذه
              // الشاشة (مسؤول الصيانة أو المدير فقط).
              if (canManage) ...[
                const SizedBox(height: 10),
                _ReportRow(
                  title: 'تحليل الصيانة',
                  subtitle: 'رسوم بيانية تفصيلية عن المهام وأداء الفنيين',
                  icon: Icons.insights_outlined,
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const MaintenanceAnalysisScreen()),
                  ),
                ),
              ],
              const SizedBox(height: 22),
              if (canManage) Builder(
                builder: (context) {
                  final phone = context.watch<AuthService>().currentUser?.phone;
                  final hasPhone = phone != null && phone.isNotEmpty;
                  return Container(
                    padding: const EdgeInsets.all(18),
                    decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(18)),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text('طلب تقرير بمدة مخصصة', style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 12),
                        InfoNote(
                          text: hasPhone
                              ? 'سيصلك رابط التقرير على واتساب رقمك ($phone) فقط — لن يُرسل للجروب'
                              : 'رقم جوالك غير مسجَّل — أضيفوه من لوحة التحكم أولًا حتى يصلك رابط التقرير على واتساب',
                          color: hasPhone ? AppColors.maintenance : AppColors.warningText,
                          icon: hasPhone ? Icons.lock_outline : Icons.warning_amber_outlined,
                        ),
                        const SizedBox(height: 12),
                        InkWell(
                          onTap: _pickRange,
                          borderRadius: BorderRadius.circular(12),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                            decoration: BoxDecoration(
                              color: AppColors.background,
                              border: Border.all(color: AppColors.border),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Row(
                              children: [
                                const Icon(Icons.date_range_outlined, size: 18, color: AppColors.textMuted),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    _selectedRange == null
                                        ? 'اختر مدة التقرير'
                                        : '${ArabicFormat.date(_selectedRange!.start)}  —  ${ArabicFormat.date(_selectedRange!.end)}',
                                    style: const TextStyle(fontSize: 13),
                                  ),
                                ),
                                const Icon(Icons.keyboard_arrow_down, size: 18, color: AppColors.textMuted),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(height: 14),
                        _requestingReport
                            ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.maintenance)))
                            : PrimaryButton(
                                label: 'إنشاء التقرير',
                                color: _selectedRange != null ? AppColors.maintenance : AppColors.textFaint,
                                icon: Icons.file_download_outlined,
                                onPressed: _selectedRange != null ? _sendReport : null,
                              ),
                      ],
                    ),
                  );
                },
              ),
              const SizedBox(height: 22),
              const Text('آخر الأنشطة', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 10),
              if (state.activityLog.isEmpty)
                const Text('لا يوجد نشاط بعد', style: TextStyle(fontSize: 13, color: AppColors.textMuted))
              else
                ...state.activityLog.take(8).map(
                      (e) => Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(e, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary, height: 1.6)),
                      ),
                    ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReportRow extends StatelessWidget {
  final String title;
  final String subtitle;
  // onTap اختياري حتى يبقى الصفّان الثابتان (الشهري/السنوي) كما هما بدون أي
  // تفاعل، بينما يصبح صفّ "تحليل الصيانة" الجديد قابلاً للنقر — بلا كسر توافق.
  final VoidCallback? onTap;
  final IconData icon;
  const _ReportRow({required this.title, required this.subtitle, this.onTap, this.icon = Icons.description_outlined});

  @override
  Widget build(BuildContext context) {
    final row = Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: AppColors.maintenance.withOpacity(0.1), borderRadius: BorderRadius.circular(12)),
            child: Icon(icon, color: AppColors.maintenance),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
              ],
            ),
          ),
          if (onTap != null) const Icon(Icons.chevron_left, size: 20, color: AppColors.textMuted),
        ],
      ),
    );
    if (onTap == null) return row;
    return InkWell(onTap: onTap, borderRadius: BorderRadius.circular(16), child: row);
  }
}
