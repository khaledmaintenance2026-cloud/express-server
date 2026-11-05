import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'production_batch_edit_screen.dart';

/// تقرير إنتاج مستقل تمامًا لكل قسم/مصنع على حِدة — يُفتح من تبويب القسم
/// نفسه في شاشة الإنتاج، فلا تختلط بيانات "مصنع الرجال" مع "مصنع النساء".
///
/// الباتشات أصبحت محفوظة على السيرفر (راجع app_state.dart) بدل كونها محلية
/// فقط على جهاز المشرف، لذا نعيد تحميلها عند فتح الشاشة تمامًا مثل خطوط
/// الإنتاج والبلاغات.
class ProductionReportsScreen extends StatefulWidget {
  final String facility;
  const ProductionReportsScreen({super.key, required this.facility});

  @override
  State<ProductionReportsScreen> createState() => _ProductionReportsScreenState();
}

class _ProductionReportsScreenState extends State<ProductionReportsScreen> {
  DateTimeRange? _selectedRange;
  bool _requestingReport = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadBatches());
  }

  // نتجنّب عمدًا تمرير locale عربي لـ showDateRangePicker (يحتاج حزمة
  // flutter_localizations غير المُضافة أصلًا في هذا المشروع — راجع ملاحظة
  // مشابهة في main.dart)، فتظهر نافذة الاختيار بالإنجليزية افتراضيًا، بينما
  // نعرض المدة المختارة بأرقام هندية عبر ArabicFormat في بقية الواجهة.
  Future<void> _pickRange() async {
    final now = DateTime.now();
    final range = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: now,
      initialDateRange: _selectedRange ?? DateTimeRange(start: now.subtract(const Duration(days: 7)), end: now),
    );
    if (range != null) setState(() => _selectedRange = range);
  }

  Future<void> _sendReport() async {
    final range = _selectedRange;
    if (range == null) return;
    setState(() => _requestingReport = true);
    try {
      // نشمل نهاية يوم "إلى" كاملًا (السيرفر يفعل ذلك أيضًا احتياطًا) حتى لا
      // يُستثنى اليوم الأخير المختار بسبب كون وقته 00:00.
      final to = DateTime(range.end.year, range.end.month, range.end.day, 23, 59, 59);
      final result = await context.read<AppState>().requestProductionReport(
            facility: widget.facility,
            from: range.start,
            to: to,
          );
      if (!mounted) return;
      if (result.whatsappSent) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('تم إنشاء التقرير وإرساله على واتساب رقمك')),
        );
      } else {
        // التقرير أُنشئ بنجاح رغم ذلك — نعرض الرابط حتى يقدر المستخدم فتحه
        // يدويًا (نسخ النص من الإشعار) لو تعذّر الإرسال التلقائي.
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

  Future<void> _deleteBatch(Batch b) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف الباتش؟', style: TextStyle(fontSize: 15)),
        content: Text('سيُحذف الباتش رقم ${b.batchNumber} نهائيًا — لا يمكن التراجع عن هذا.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            style: TextButton.styleFrom(foregroundColor: const Color(0xFFB3261E)),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await context.read<AppState>().removeBatchCloud(b.id);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم حذف الباتش')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر حذف الباتش: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final role = context.watch<AuthService>().currentUser?.role ?? AppRole.production;
    final canManage = canManageBatches(role);
    final lines = state.linesByFacility(widget.facility);
    // لو اختار المستخدم مدة مخصّصة (لطلب تقرير واتساب)، نعرض باتشات نفس
    // المدة بدل "اليوم" فقط — حتى يقدر مسؤول الإنتاج يصل لباتش قديم ليعدّله.
    final range = _selectedRange;
    final batches = range != null
        ? state.batchesInRange(widget.facility, from: range.start, to: DateTime(range.end.year, range.end.month, range.end.day, 23, 59, 59))
        : state.batchesByFacility(widget.facility);
    final totalToday = batches.fold<int>(0, (sum, b) => sum + b.quantity);
    final activeLines = lines.where((l) => l.activeToday).length;

    return Scaffold(
      appBar: ScreenTopBar(title: 'تقارير ${widget.facility}'),
      body: RefreshIndicator(
        onRefresh: () => state.reloadBatches(),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: ListView(
            children: [
              Row(
                children: [
                  KpiCard(value: ArabicFormat.number(totalToday), label: 'إجمالي الإنتاج اليوم', valueColor: AppColors.production),
                  const SizedBox(width: 10),
                  KpiCard(value: ArabicFormat.number(batches.length), label: 'باتشات اليوم', valueColor: AppColors.production),
                  const SizedBox(width: 10),
                  KpiCard(value: '${ArabicFormat.number(activeLines)}/${ArabicFormat.number(lines.length)}', label: 'خطوط نشطة اليوم', valueColor: AppColors.production),
                ],
              ),
              const SizedBox(height: 20),
              const Text('تقارير تلقائية عبر واتساب', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 10),
              _ReportRow(title: 'التقرير الأسبوعي', subtitle: 'رابط تقرير — كل ٧ أيام تقريبًا لجروب ${widget.facility}'),
              const SizedBox(height: 10),
              _ReportRow(title: 'التقرير الشهري', subtitle: 'رابط تقرير — كل ٣٠ يومًا تقريبًا، الكمية والباتشات لكل خط في ${widget.facility}'),
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
                          color: hasPhone ? AppColors.production : AppColors.warningText,
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
                            ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator()))
                            : PrimaryButton(
                                label: 'إنشاء وإرسال التقرير',
                                color: _selectedRange != null ? AppColors.production : AppColors.textFaint,
                                icon: Icons.send_outlined,
                                onPressed: _selectedRange != null ? _sendReport : null,
                              ),
                      ],
                    ),
                  );
                },
              ),
              const SizedBox(height: 22),
              Text(
                _selectedRange == null ? 'باتشات ${widget.facility} اليوم' : 'باتشات ${widget.facility} — المدة المختارة أعلاه',
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: AppColors.textSecondary),
              ),
              const SizedBox(height: 10),
              if (state.batchesError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: InfoNote(text: state.batchesError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ),
              if (!state.batchesLoaded && state.batchesError == null)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Center(child: CircularProgressIndicator()),
                )
              else if (batches.isEmpty)
                Text(
                  _selectedRange == null ? 'لا توجد باتشات مسجّلة اليوم' : 'لا توجد باتشات في هذه المدة',
                  style: const TextStyle(fontSize: 13, color: AppColors.textMuted),
                )
              else
                ...batches.map(
                  (b) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(child: Text('${state.lineById(b.lineId).name} — ${b.productName}', style: const TextStyle(fontSize: 13))),
                              Text(ArabicFormat.number(b.quantity), style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.production)),
                            ],
                          ),
                          const SizedBox(height: 3),
                          Text(
                            'باتش رقم: ${b.batchNumber} — ${ArabicFormat.date(b.date)}',
                            style: const TextStyle(fontSize: 11.5, color: AppColors.textFaint),
                          ),
                          if (b.workOrderId != null) ...[
                            const SizedBox(height: 6),
                            _WorkOrderLinkBadge(workOrderId: b.workOrderId!),
                          ],
                          if ((b.operationalNotes?.isNotEmpty ?? false) || (b.hasStoppage && (b.actionsTaken?.isNotEmpty ?? false))) ...[
                            const SizedBox(height: 6),
                            if (b.operationalNotes?.isNotEmpty ?? false)
                              Text('ملاحظات تشغيلية: ${b.operationalNotes}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                            if (b.hasStoppage && (b.actionsTaken?.isNotEmpty ?? false))
                              Text('الإجراءات المتخذة: ${b.actionsTaken}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                          ],
                          if (canManage) ...[
                            const SizedBox(height: 6),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.end,
                              children: [
                                TextButton.icon(
                                  onPressed: () => Navigator.of(context).push(
                                    MaterialPageRoute(
                                      builder: (_) => ProductionBatchEditScreen(batch: b, line: state.lineById(b.lineId)),
                                    ),
                                  ),
                                  icon: const Icon(Icons.edit_outlined, size: 16),
                                  label: const Text('تعديل', style: TextStyle(fontSize: 12)),
                                  style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 32)),
                                ),
                                const SizedBox(width: 6),
                                TextButton.icon(
                                  onPressed: () => _deleteBatch(b),
                                  icon: const Icon(Icons.delete_outline, size: 16, color: Color(0xFFB3261E)),
                                  label: const Text('حذف', style: TextStyle(fontSize: 12, color: Color(0xFFB3261E))),
                                  style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(0, 32)),
                                ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// شارة صغيرة تظهر على باتش مربوط بأمر صيانة فعلي — تعرض اسم المعدة/الوصف
/// وحالة الأمر الحالية (تُقرأ من maintenanceReports المحمَّلة أصلًا، بلا طلب
/// سيرفر إضافي). لو تعذّر إيجاد الأمر محليًا لأي سبب (نادر) تُخفى الشارة
/// بصمت بدل إظهار معرّف رقمي بلا معنى للمستخدم.
class _WorkOrderLinkBadge extends StatelessWidget {
  final String workOrderId;
  const _WorkOrderLinkBadge({required this.workOrderId});

  @override
  Widget build(BuildContext context) {
    final report = context.watch<AppState>().maintenanceReportById(workOrderId);
    if (report == null) return const SizedBox.shrink();
    final title = report.equipment.isNotEmpty ? report.equipment : report.description;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(color: AppColors.maintenance.withOpacity(0.08), borderRadius: BorderRadius.circular(8)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.link, size: 13, color: AppColors.maintenance),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              'متوقف بسبب صيانة: $title (${maintenanceStatusLabel(report.status)})',
              style: const TextStyle(fontSize: 11, color: AppColors.maintenance, fontWeight: FontWeight.w600),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
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
            decoration: BoxDecoration(color: AppColors.production.withOpacity(0.1), borderRadius: BorderRadius.circular(12)),
            child: const Icon(Icons.description_outlined, color: AppColors.production),
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
