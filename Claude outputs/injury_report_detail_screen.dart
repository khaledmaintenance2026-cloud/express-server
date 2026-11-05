import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/injury_report.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'injury_report_form_screen.dart';
import 'injury_report_print_screen.dart';

/// شاشة تفاصيل تقرير تحقيق إصابة عمل كامل — تعرض كل الخطوات الخمس، وتتيح
/// تعديل التقرير (طالما مفتوحًا)، تحديث حالة إجراءات المتابعة، اعتماده
/// وإغلاقه نهائيًا أو إعادة فتحه، حذفه، وطباعته كملف PDF.
class InjuryReportDetailScreen extends StatefulWidget {
  final String reportId;
  const InjuryReportDetailScreen({super.key, required this.reportId});

  @override
  State<InjuryReportDetailScreen> createState() => _InjuryReportDetailScreenState();
}

class _InjuryReportDetailScreenState extends State<InjuryReportDetailScreen> {
  InjuryReport? _report;
  String? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final report = await context.read<AppState>().fetchInjuryReportDetail(widget.reportId);
      if (!mounted) return;
      setState(() {
        _report = report;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'تعذّر تحميل تفاصيل التقرير: $e');
    }
  }

  Future<void> _editReport() async {
    final report = _report;
    if (report == null) return;
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => InjuryReportFormScreen(existing: report)),
    );
    if (saved == true) _load();
  }

  Future<void> _toggleAction(InjuryReportAction action) async {
    final report = _report;
    if (report == null || action.id == null) return;
    setState(() => _busy = true);
    try {
      await context.read<AppState>().setInjuryActionDone(report.id, action.id!, !action.done);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر تحديث حالة الإجراء: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _closeReport() async {
    final report = _report;
    if (report == null) return;
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => const _CloseReportDialog(),
    );
    if (result == null) return;
    setState(() => _busy = true);
    try {
      await context.read<AppState>().closeInjuryReportCloud(
            report.id,
            approvedBy: result['approvedBy']!,
            approvedByTitle: result['approvedByTitle'],
          );
      await _load();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم اعتماد التقرير وإغلاقه')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر إغلاق التقرير: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reopenReport() async {
    final report = _report;
    if (report == null) return;
    setState(() => _busy = true);
    try {
      await context.read<AppState>().reopenInjuryReportCloud(report.id);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر إعادة فتح التقرير: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deleteReport() async {
    final report = _report;
    if (report == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف تقرير الإصابة؟'),
        content: const Text('سيُحذف هذا التقرير نهائيًا ولا يمكن التراجع.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await context.read<AppState>().removeInjuryReportCloud(report.id);
      if (!mounted) return;
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر حذف التقرير: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final report = _report;
    return Scaffold(
      appBar: ScreenTopBar(
        title: 'تفاصيل تقرير الإصابة',
        actions: report == null
            ? null
            : [
                IconButton(
                  icon: const Icon(Icons.print_outlined),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => InjuryReportPrintScreen(report: report))),
                ),
              ],
      ),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted))))
          : report == null
              ? const Center(child: CircularProgressIndicator())
              : AbsorbPointer(
                  absorbing: _busy,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(20, 10, 20, 30),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _statusHeader(report),
                        const SizedBox(height: 16),
                        _sectionHeader('بيانات الحادث'),
                        _kv('رقم الحادث', report.incidentNumber ?? '—'),
                        _kv('القسم', report.department),
                        _kv('تاريخ التحقيق', ArabicFormat.date(report.investigationDate)),
                        _kv('طبيعة الحادث', multiLabel(kNatureOfAccidentLabels, report.natureOfAccident)),
                        _kv('نوع الإصابة/المرض', multiLabel(kInjuryTypeLabels, report.injuryTypes)),
                        const SizedBox(height: 14),
                        _sectionHeader('الخطوة ١ — الموظفون المصابون (${report.injuredCount})'),
                        if (report.employees.isEmpty) _emptyNote('لا يوجد موظفون مصابون مسجّلون') else ...report.employees.map(_employeeCard),
                        const SizedBox(height: 14),
                        _sectionHeader('الخطوة ٢ — ظروف الحادث'),
                        _kv('الموقع بالتفصيل', report.incidentLocation),
                        _kv('تاريخ ووقت الحادث', ArabicFormat.dateTime(report.occurredAt)),
                        _kv('جزء الدوام', report.workdayPart != null ? (kWorkdayPartLabels[report.workdayPart] ?? report.workdayPart!) : '—'),
                        _kv('معدات الحماية المستخدمة', multiLabel(kInjuryPpeLabels, report.ppeUsed)),
                        _kv('وصف الحادثة', report.incidentDescription),
                        const SizedBox(height: 14),
                        _sectionHeader('الخطوة ٣ — تحليل السبب الجذري'),
                        _kv('سبب الظروف غير الآمنة', report.unsafeConditionReason ?? '—'),
                        _kv('سبب التصرفات غير الآمنة', report.unsafeActReason ?? '—'),
                        _kv('أسباب عظم السمكة', multiLabel(kFishboneAllLabels, report.fishboneCauses)),
                        const SizedBox(height: 14),
                        _sectionHeader('الخطوة ٤ — هرم الضوابط والإجراءات'),
                        _kv(
                          'الضوابط المختارة',
                          report.hierarchyOfControls.isEmpty
                              ? '—'
                              : report.hierarchyOfControls.map((k) {
                                  final label = kHierarchyOfControlLabels[k] ?? k;
                                  final details = report.controlDetails[k];
                                  return details != null && details.isNotEmpty ? '$label: $details' : label;
                                }).join('\n'),
                        ),
                        _kv('التغييرات المطلوبة', multiLabel(kPreventionChangeLabels, report.preventionChanges)),
                        const SizedBox(height: 8),
                        const Text('جدول متابعة الإجراءات', style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 8),
                        if (report.actions.isEmpty) _emptyNote('لا توجد إجراءات مسجّلة') else ...report.actions.map((a) => _actionRow(a)),
                        const SizedBox(height: 14),
                        _sectionHeader('الخطوة ٥ — الاعتماد'),
                        _kv('كتب التقرير بواسطة', report.writtenBy ?? '—'),
                        _kv('فريق التحقيق', report.investigators.map((i) => i.name).join('، ').isEmpty ? '—' : report.investigators.map((i) => i.name).join('، ')),
                        _kv('تم الاعتماد بواسطة', report.approvedBy ?? 'بانتظار الاعتماد'),
                        if (report.approvedAt != null) _kv('تاريخ الاعتماد', ArabicFormat.dateTime(report.approvedAt!)),
                        const SizedBox(height: 22),
                        if (!report.isClosed) ...[
                          PrimaryButton(label: 'تعديل التقرير', color: AppColors.safety, icon: Icons.edit_outlined, onPressed: _editReport),
                          const SizedBox(height: 10),
                          PrimaryButton(label: 'اعتماد التقرير وإغلاقه', color: AppColors.production, icon: Icons.verified_outlined, onPressed: _closeReport),
                        ] else
                          PrimaryButton(label: 'إعادة فتح التقرير للتعديل', color: AppColors.safety, icon: Icons.lock_open_outlined, onPressed: _reopenReport),
                        const SizedBox(height: 10),
                        OutlinedButton.icon(
                          onPressed: _deleteReport,
                          icon: const Icon(Icons.delete_outline, color: Color(0xFFB3261E)),
                          label: const Text('حذف التقرير', style: TextStyle(color: Color(0xFFB3261E))),
                        ),
                      ],
                    ),
                  ),
                ),
    );
  }

  Widget _statusHeader(InjuryReport report) {
    final closed = report.isClosed;
    final info = closed
        ? (label: 'مُغلَق (معتمد)', color: AppColors.successText, bg: AppColors.successBg)
        : (label: 'مفتوح (قيد التحقيق)', color: AppColors.warningText, bg: AppColors.warningBg);
    return Row(
      children: [
        Expanded(
          child: Text(
            report.incidentNumber != null && report.incidentNumber!.isNotEmpty ? 'حادث ${report.incidentNumber}' : 'حادث بدون رقم',
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold),
          ),
        ),
        StatusPill(label: info.label, color: info.color, background: info.bg),
      ],
    );
  }

  Widget _sectionHeader(String title) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(title, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
      );

  Widget _kv(String label, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(width: 140, child: Text(label, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary))),
            Expanded(child: Text(value.isEmpty ? '—' : value, style: const TextStyle(fontSize: 13, color: AppColors.textPrimary))),
          ],
        ),
      );

  Widget _emptyNote(String text) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Text(text, style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
      );

  Widget _employeeCard(InjuryReportEmployee e) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(14)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(e.employeeName, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold))),
              if (e.isFatality) const StatusPill(label: 'وفاة', color: Color(0xFFB3261E), background: Color(0x1FB3261E)),
            ],
          ),
          const SizedBox(height: 6),
          if (e.jobTitle != null && e.jobTitle!.isNotEmpty) Text(e.jobTitle!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
          if (e.bodyPartsAffected.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'الجزء المتضرر: ${multiLabel(kBodyPartLabels, e.bodyPartsAffected)}'
                '${e.bodyInjurySide != null ? ' (${kBodyInjurySideLabels[e.bodyInjurySide]})' : ''}',
                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
              ),
            ),
          if (e.bodyDiagramImage != null && e.bodyDiagramImage!.startsWith('/'))
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: Image.network(
                  '$kApiOrigin${e.bodyDiagramImage}',
                  height: 150,
                  fit: BoxFit.contain,
                  errorBuilder: (_, __, ___) => const SizedBox.shrink(),
                ),
              ),
            ),
          if (e.injuryNature.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text('طبيعة الإصابة: ${multiLabel(kInjuryNatureLabels, e.injuryNature)}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
          if (e.lostWorkDays > 0)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text('أيام الغياب: ${ArabicFormat.toEasternDigits(e.lostWorkDays)}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ),
        ],
      ),
    );
  }

  Widget _actionRow(InjuryReportAction a) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          Checkbox(
            value: a.done,
            activeColor: AppColors.production,
            onChanged: a.id == null ? null : (_) => _toggleAction(a),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(a.actionDescription, style: const TextStyle(fontSize: 13, decoration: TextDecoration.none)),
                if (a.responsiblePerson != null || a.targetDate != null)
                  Text(
                    [
                      if (a.responsiblePerson != null) 'المسؤول: ${a.responsiblePerson}',
                      if (a.targetDate != null) 'الموعد: ${ArabicFormat.date(a.targetDate!)}',
                    ].join(' — '),
                    style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _CloseReportDialog extends StatefulWidget {
  const _CloseReportDialog();

  @override
  State<_CloseReportDialog> createState() => _CloseReportDialogState();
}

class _CloseReportDialogState extends State<_CloseReportDialog> {
  final _nameCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();

  @override
  void dispose() {
    _nameCtrl.dispose();
    _titleCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('اعتماد التقرير وإغلاقه'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('لن يمكن تعديل التقرير بعد الإغلاق إلا بإعادة فتحه أولًا.', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          const SizedBox(height: 14),
          TextField(controller: _nameCtrl, decoration: const InputDecoration(labelText: 'تم الاعتماد بواسطة')),
          const SizedBox(height: 10),
          TextField(controller: _titleCtrl, decoration: const InputDecoration(labelText: 'المسمى الوظيفي (اختياري)')),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('إلغاء')),
        TextButton(
          onPressed: () {
            if (_nameCtrl.text.trim().isEmpty) return;
            Navigator.of(context).pop({
              'approvedBy': _nameCtrl.text.trim(),
              'approvedByTitle': _titleCtrl.text.trim(),
            });
          },
          child: const Text('اعتماد وإغلاق'),
        ),
      ],
    );
  }
}
