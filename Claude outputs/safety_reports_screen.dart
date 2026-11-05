import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/safety_permit.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة تقارير السلامة — بنفس نمط maintenance_reports_screen.dart تمامًا:
/// أرقام حقيقية محسوبة من طلبات تصاريح العمل الفعلية، وتقرير مخصّص يُنشئ
/// ملفًا حقيقيًا ويُرسل رابطه عبر واتساب لرقم طالبه. التقريران الأسبوعي
/// والشهري تلقائيان بالكامل (راجع services/safetyReportScheduler.js على
/// السيرفر) — جروب واتساب السلامة يستلمهما بلا أي تدخل من أحد هنا.
class SafetyReportsScreen extends StatefulWidget {
  const SafetyReportsScreen({super.key});

  @override
  State<SafetyReportsScreen> createState() => _SafetyReportsScreenState();
}

class _SafetyReportsScreenState extends State<SafetyReportsScreen> {
  DateTimeRange? _selectedRange;
  bool _requestingReport = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadPermits());
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
      final result = await context.read<AppState>().requestSafetyReport(from: range.start, to: to);
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
    final permits = state.permits;
    final approvedCount = permits.where((p) => p.status == PermitStatus.approved).length;
    final rejectedCount = permits.where((p) => p.status == PermitStatus.rejected).length;

    return Scaffold(
      appBar: const ScreenTopBar(title: 'تقارير السلامة'),
      body: RefreshIndicator(
        onRefresh: () => state.reloadPermits(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: ListView(
            children: [
              if (state.permitsError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: InfoNote(text: state.permitsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ),
              Row(
                children: [
                  KpiCard(value: ArabicFormat.number(permits.length), label: 'إجمالي طلبات التصاريح', valueColor: AppColors.safetyText),
                  const SizedBox(width: 10),
                  KpiCard(value: ArabicFormat.number(approvedCount), label: 'مقبولة', valueColor: AppColors.safetyText),
                  const SizedBox(width: 10),
                  KpiCard(value: ArabicFormat.number(rejectedCount), label: 'مرفوضة', valueColor: AppColors.safetyText),
                ],
              ),
              const SizedBox(height: 20),
              const Text('تقارير تلقائية عبر واتساب', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 10),
              const _ReportRow(title: 'التقرير الأسبوعي', subtitle: 'رابط تقرير — كل ٧ أيام تقريبًا لجروب السلامة'),
              const SizedBox(height: 10),
              const _ReportRow(title: 'التقرير الشهري', subtitle: 'رابط تقرير — كل ٣٠ يومًا تقريبًا لجروب السلامة'),
              const SizedBox(height: 22),
              Builder(
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
                          color: hasPhone ? AppColors.safetyText : AppColors.warningText,
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
                            ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.safetyText)))
                            : PrimaryButton(
                                label: 'إنشاء التقرير',
                                color: _selectedRange != null ? AppColors.safety : AppColors.textFaint,
                                icon: Icons.file_download_outlined,
                                onPressed: _selectedRange != null ? _sendReport : null,
                              ),
                      ],
                    ),
                  );
                },
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
  const _ReportRow({required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: AppColors.safety.withOpacity(0.15), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.description_outlined, color: AppColors.safetyText),
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
        ],
      ),
    );
  }
}
