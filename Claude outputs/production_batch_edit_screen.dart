import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/batch_edit.dart';
import '../../models/maintenance_report.dart';
import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// تعديل باتش قديم — متاحة فقط لصلاحية "مسؤول إنتاج" أو مدير النظام (راجع
/// canManageBatches في auth_service.dart)، تُستدعى من زر التعديل في قائمة
/// الباتشات (production_reports_screen.dart). لا تسمح بتغيير الخط عمدًا —
/// تبسيطًا، ولأن نقل باتش بين الخطوط حالة نادرة جدًا لا تستحق التعقيد الإضافي.
class ProductionBatchEditScreen extends StatefulWidget {
  final Batch batch;
  final ProductionLine line;
  const ProductionBatchEditScreen({super.key, required this.batch, required this.line});

  @override
  State<ProductionBatchEditScreen> createState() => _ProductionBatchEditScreenState();
}

class _ProductionBatchEditScreenState extends State<ProductionBatchEditScreen> {
  late final TextEditingController _batchNumberCtrl;
  late final TextEditingController _productCtrl;
  late final TextEditingController _qtyCtrl;
  late final TextEditingController _workersCtrl;
  late final TextEditingController _reasonCtrl;
  late final TextEditingController _minutesCtrl;
  late final TextEditingController _operationalNotesCtrl;
  late final TextEditingController _actionsTakenCtrl;
  late final TextEditingController _preventionMethodsCtrl;
  late DateTime _occurredDate;
  bool _hasStoppage = false;
  bool _submitting = false;

  /// أمر الصيانة الفعلي المرتبط بهذا الباتش (اختياري) — راجع نفس الحقل في
  /// production_batch_form_screen.dart لشرح كامل لمنطق الربط/الحساب التلقائي.
  String? _workOrderId;

  @override
  void initState() {
    super.initState();
    final b = widget.batch;
    _batchNumberCtrl = TextEditingController(text: b.batchNumber);
    _productCtrl = TextEditingController(text: b.productName);
    _qtyCtrl = TextEditingController(text: b.quantity.toString());
    _workersCtrl = TextEditingController(text: b.workersCount?.toString() ?? '');
    _reasonCtrl = TextEditingController(text: b.stoppageReason ?? '');
    _minutesCtrl = TextEditingController(text: b.stoppageMinutes?.toString() ?? '');
    _operationalNotesCtrl = TextEditingController(text: b.operationalNotes ?? '');
    _actionsTakenCtrl = TextEditingController(text: b.actionsTaken ?? '');
    _preventionMethodsCtrl = TextEditingController(text: b.preventionMethods ?? '');
    _occurredDate = b.date;
    _hasStoppage = b.hasStoppage;
    _workOrderId = b.workOrderId;
  }

  @override
  void dispose() {
    _batchNumberCtrl.dispose();
    _productCtrl.dispose();
    _qtyCtrl.dispose();
    _workersCtrl.dispose();
    _reasonCtrl.dispose();
    _minutesCtrl.dispose();
    _operationalNotesCtrl.dispose();
    _actionsTakenCtrl.dispose();
    _preventionMethodsCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredDate,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (picked != null) setState(() => _occurredDate = picked);
  }

  bool get _canSubmit {
    if (_submitting) return false;
    final qty = int.tryParse(_qtyCtrl.text.trim());
    if (_batchNumberCtrl.text.trim().isEmpty) return false;
    if (_productCtrl.text.trim().isEmpty || qty == null || qty <= 0) return false;
    if (_workOrderId == null && _hasStoppage && _reasonCtrl.text.trim().isEmpty) return false;
    return true;
  }

  Future<void> _submit() async {
    setState(() => _submitting = true);
    final b = widget.batch;
    final now = DateTime.now();
    final occurredAt = DateTime(
      _occurredDate.year,
      _occurredDate.month,
      _occurredDate.day,
      now.hour,
      now.minute,
      now.second,
    );
    try {
      // workOrderId/unlinkWorkOrder يُرسَلان دائمًا (لا بالشرط if != null)
      // ليعكسا حالة الربط الحالية بدقة — راجع editBatchCloud في app_state.dart.
      // لو رُبط بأمر صيانة، يتجاهل السيرفر حقول التوقف اليدوية أدناه ويحسبها
      // بنفسه من بيانات الأمر (راجع routes/production.js — PATCH /batches/:id).
      await context.read<AppState>().editBatchCloud(
            b.id,
            batchNumber: _batchNumberCtrl.text.trim(),
            productName: _productCtrl.text.trim(),
            quantity: int.parse(_qtyCtrl.text.trim()),
            occurredAt: occurredAt,
            workOrderId: _workOrderId,
            unlinkWorkOrder: _workOrderId == null,
            hasStoppage: _hasStoppage,
            stoppageReason: _hasStoppage ? _reasonCtrl.text.trim() : '',
            stoppageMinutes: _hasStoppage ? int.tryParse(_minutesCtrl.text.trim()) : 0,
            operationalNotes: _operationalNotesCtrl.text.trim(),
            actionsTaken: (_workOrderId != null || _hasStoppage) ? _actionsTakenCtrl.text.trim() : '',
            workersCount: int.tryParse(_workersCtrl.text.trim()) ?? 0,
            preventionMethods: (_workOrderId != null || _hasStoppage) ? _preventionMethodsCtrl.text.trim() : '',
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم حفظ التعديلات')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر حفظ التعديل: $e')),
      );
    }
  }

  Future<void> _showHistory() async {
    showDialog(
      context: context,
      builder: (ctx) => _BatchEditHistoryDialog(batchId: widget.batch.id),
    );
  }

  @override
  Widget build(BuildContext context) {
    final workOrders = context.watch<AppState>().openWorkOrdersForLinking;
    // أمر العمل المرتبط حاليًا قد يكون أُنجز/أُغلق فعلاً (فلا يظهر ضمن
    // openWorkOrdersForLinking بعد الآن) — نضيفه للقائمة صراحة حتى يبقى
    // ظاهرًا ومُختارًا في القائمة المنسدلة بدل اختفائه فجأة عند فتح الشاشة.
    final currentLinked = _workOrderId == null ? null : context.read<AppState>().maintenanceReportById(_workOrderId!);
    final dropdownOptions = [
      ...workOrders,
      if (currentLinked != null && !workOrders.any((r) => r.id == currentLinked.id)) currentLinked,
    ];
    return Scaffold(
      appBar: ScreenTopBar(
        title: 'تعديل باتش — ${widget.line.name}',
        actions: [
          IconButton(
            tooltip: 'سجل التعديلات',
            icon: const Icon(Icons.history),
            onPressed: _showHistory,
          ),
        ],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
              child: ListView(
                children: [
                  const InfoNote(
                    text: 'أي تغيير هنا يُسجَّل في سجل التعديلات مع اسمك ووقت التعديل — راجع أيقونة السجل أعلى الشاشة.',
                    color: AppColors.production,
                    icon: Icons.info_outline,
                  ),
                  const SizedBox(height: 16),
                  const _Label('تاريخ الباتش'),
                  OutlinedButton.icon(
                    onPressed: _pickDate,
                    icon: const Icon(Icons.event_outlined, size: 18),
                    label: Text(ArabicFormat.date(_occurredDate)),
                    style: OutlinedButton.styleFrom(alignment: Alignment.centerRight),
                  ),
                  const SizedBox(height: 14),
                  const _Label('رقم الباتش'),
                  TextField(controller: _batchNumberCtrl, decoration: _decoration(), onChanged: (_) => setState(() {})),
                  const SizedBox(height: 14),
                  const _Label('اسم المنتج'),
                  TextField(controller: _productCtrl, decoration: _decoration(), onChanged: (_) => setState(() {})),
                  const SizedBox(height: 14),
                  const _Label('الكمية'),
                  TextField(
                    controller: _qtyCtrl,
                    keyboardType: TextInputType.number,
                    decoration: _decoration(),
                    onChanged: (_) => setState(() {}),
                  ),
                  const SizedBox(height: 14),
                  const _Label('عدد العمال'),
                  TextField(controller: _workersCtrl, keyboardType: TextInputType.number, decoration: _decoration()),
                  const SizedBox(height: 18),
                  const _Label('ربط بأمر صيانة فعلي (اختياري)'),
                  DropdownButtonFormField<String?>(
                    value: _workOrderId,
                    decoration: _decoration(),
                    isExpanded: true,
                    items: [
                      const DropdownMenuItem<String?>(
                        value: null,
                        child: Text('بدون ربط — إدخال بيانات التوقف يدويًا', style: TextStyle(color: AppColors.textMuted)),
                      ),
                      ...dropdownOptions.map(
                        (r) => DropdownMenuItem<String?>(
                          value: r.id,
                          child: Text(_workOrderLabel(r), overflow: TextOverflow.ellipsis),
                        ),
                      ),
                    ],
                    onChanged: (v) => setState(() => _workOrderId = v),
                  ),
                  const SizedBox(height: 6),
                  const Text(
                    'لو اخترت أمر صيانة، تُحسَب مدة وسبب التوقف تلقائيًا من بياناته الفعلية بدل إدخالهما يدويًا.',
                    style: TextStyle(fontSize: 11.5, color: AppColors.textMuted, height: 1.5),
                  ),
                  const SizedBox(height: 14),
                  if (_workOrderId != null)
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(color: AppColors.maintenance.withOpacity(0.08), borderRadius: BorderRadius.circular(14)),
                      child: const Row(
                        children: [
                          Icon(Icons.link, size: 18, color: AppColors.maintenance),
                          SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              'سيُسجَّل هذا الباتش كمتوقف بسبب أمر الصيانة المختار، وتُحدَّث المدة تلقائيًا عند إنجازه.',
                              style: TextStyle(fontSize: 12, color: AppColors.maintenance, fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                      ),
                    )
                  else
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(14)),
                      child: Row(
                        children: [
                          const Expanded(
                            child: Text('هل حدث توقف أثناء هذا الباتش؟', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                          ),
                          Switch(
                            value: _hasStoppage,
                            activeColor: AppColors.safety,
                            onChanged: (v) => setState(() => _hasStoppage = v),
                          ),
                        ],
                      ),
                    ),
                  if (_workOrderId == null && _hasStoppage) ...[
                    const SizedBox(height: 14),
                    const _Label('سبب التوقف'),
                    TextField(controller: _reasonCtrl, decoration: _decoration(), onChanged: (_) => setState(() {})),
                    const SizedBox(height: 14),
                    const _Label('مدة التوقف (بالدقائق)'),
                    TextField(controller: _minutesCtrl, keyboardType: TextInputType.number, decoration: _decoration()),
                  ],
                  if (_workOrderId != null || _hasStoppage) ...[
                    const SizedBox(height: 14),
                    const _Label('الحلول والإجراءات المتخذة'),
                    TextField(controller: _actionsTakenCtrl, maxLines: 3, decoration: _decoration()),
                    const SizedBox(height: 14),
                    const _Label('طرق تجنّب تكرار المشكلة'),
                    TextField(controller: _preventionMethodsCtrl, maxLines: 3, decoration: _decoration()),
                  ],
                  const SizedBox(height: 14),
                  const _Label('الملاحظات التشغيلية'),
                  TextField(controller: _operationalNotesCtrl, maxLines: 4, decoration: _decoration()),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator()))
                : PrimaryButton(
                    label: 'حفظ التعديلات',
                    color: _canSubmit ? AppColors.production : AppColors.textFaint,
                    icon: Icons.check,
                    onPressed: _canSubmit ? _submit : null,
                  ),
          ),
        ],
      ),
    );
  }
}

class _BatchEditHistoryDialog extends StatelessWidget {
  final String batchId;
  const _BatchEditHistoryDialog({required this.batchId});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('سجل تعديلات الباتش', style: TextStyle(fontSize: 15)),
      content: SizedBox(
        width: double.maxFinite,
        child: FutureBuilder<List<BatchEdit>>(
          future: context.read<AppState>().loadBatchEdits(batchId),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Padding(
                padding: EdgeInsets.all(20),
                child: Center(child: CircularProgressIndicator()),
              );
            }
            if (snapshot.hasError) {
              return Text('تعذّر تحميل السجل: ${snapshot.error}', style: const TextStyle(fontSize: 12.5));
            }
            final edits = snapshot.data ?? [];
            if (edits.isEmpty) {
              return const Text('لا توجد تعديلات مسجّلة على هذا الباتش بعد.', style: TextStyle(fontSize: 13, color: AppColors.textMuted));
            }
            return ListView.separated(
              shrinkWrap: true,
              itemCount: edits.length,
              separatorBuilder: (_, __) => const Divider(height: 18),
              itemBuilder: (context, i) {
                final e = edits[i];
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${e.editedByName ?? 'مستخدم'} — ${ArabicFormat.dateTime(e.editedAt)}',
                      style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 4),
                    ...e.changes.entries.map((entry) {
                      final v = entry.value as Map?;
                      return Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          '${batchFieldLabel(entry.key)}: ${v?['old'] ?? '—'} ← ${v?['new'] ?? '—'}',
                          style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                        ),
                      );
                    }),
                  ],
                );
              },
            );
          },
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('إغلاق')),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
    );
  }
}

// نص مختصر لعنصر أمر عمل ضمن قائمة الربط — راجع نفس الدالة في
// production_batch_form_screen.dart.
String _workOrderLabel(MaintenanceReport r) {
  final title = r.equipment.isNotEmpty
      ? r.equipment
      : (r.description.length > 30 ? '${r.description.substring(0, 30)}…' : r.description);
  return '$title — ${maintenanceStatusLabel(r.status)}';
}

InputDecoration _decoration() {
  return InputDecoration(
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
