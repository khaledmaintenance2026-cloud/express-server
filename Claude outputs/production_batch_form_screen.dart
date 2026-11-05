import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

class ProductionBatchFormScreen extends StatefulWidget {
  final ProductionLine line;
  const ProductionBatchFormScreen({super.key, required this.line});

  @override
  State<ProductionBatchFormScreen> createState() => _ProductionBatchFormScreenState();
}

class _ProductionBatchFormScreenState extends State<ProductionBatchFormScreen> with SingleTickerProviderStateMixin {
  final _batchNumberCtrl = TextEditingController();
  final _productCtrl = TextEditingController();
  final _qtyCtrl = TextEditingController();
  final _workersCtrl = TextEditingController();
  final _reasonCtrl = TextEditingController();
  final _minutesCtrl = TextEditingController();
  final _operationalNotesCtrl = TextEditingController();
  final _actionsTakenCtrl = TextEditingController();
  final _preventionMethodsCtrl = TextEditingController();
  TimeOfDay? _timeFrom;
  TimeOfDay? _timeTo;

  /// تاريخ الباتش "الفعلي" — افتراضيًا اليوم (نفس السلوك السابق تمامًا)، مع
  /// إمكانية اختيار تاريخ سابق لتسجيل باتش نُسي تسجيله في وقته — بلا حد على
  /// القدم. راجع occurred_at في routes/production.js على السيرفر.
  DateTime _occurredDate = DateTime.now();
  bool _hasStoppage = false;
  bool _submitting = false;

  /// أمر الصيانة الفعلي المرتبط بهذا الباتش (اختياري) — عند تحديده، تُحسَب
  /// مدة وسبب التوقف تلقائيًا من بيانات ذلك الأمر بدل إدخالهما يدويًا (راجع
  /// computeStoppageFromWorkOrder في services/batchWorkOrderLink.js بالسيرفر).
  String? _workOrderId;
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  @override
  void dispose() {
    _tabController.dispose();
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

  // TimeOfDay → "08:00:00" لإرسالها كعمود TIME للسيرفر.
  String? _timeOfDayToString(TimeOfDay? t) {
    if (t == null) return null;
    return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}:00';
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredDate,
      // بلا حد على القدم — أقدم تاريخ ممكن اختياره بعيد جدًا عمدًا.
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (picked != null) setState(() => _occurredDate = picked);
  }

  Future<void> _pickTime(bool isFrom) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: (isFrom ? _timeFrom : _timeTo) ?? TimeOfDay.now(),
    );
    if (picked != null) {
      setState(() {
        if (isFrom) {
          _timeFrom = picked;
        } else {
          _timeTo = picked;
        }
      });
    }
  }

  bool get _canSubmit {
    if (_submitting) return false;
    final qty = int.tryParse(_qtyCtrl.text.trim());
    final workers = int.tryParse(_workersCtrl.text.trim());
    if (_batchNumberCtrl.text.trim().isEmpty) return false;
    if (_productCtrl.text.trim().isEmpty || qty == null || qty <= 0) return false;
    if (workers == null || workers <= 0) return false;
    // لو رُبط الباتش بأمر صيانة، سبب/مدة التوقف يُحسبان تلقائيًا فلا حاجة
    // لإدخالهما — القيد يبقى فقط عند الإدخال اليدوي.
    if (_workOrderId == null && _hasStoppage && _reasonCtrl.text.trim().isEmpty) return false;
    return true;
  }

  Future<void> _submit() async {
    setState(() => _submitting = true);
    try {
      final now = DateTime.now();
      final occurredAt = DateTime(
        _occurredDate.year,
        _occurredDate.month,
        _occurredDate.day,
        now.hour,
        now.minute,
        now.second,
      );
      // لو رُبط الباتش بأمر صيانة: السيرفر يحسب حقول التوقف الثلاثة تلقائيًا
      // من بيانات ذلك الأمر ويتجاهل أي قيم يدوية لها، فلا نرسلها أصلاً هنا
      // (راجع routes/production.js — POST /batches). الحلول/طرق التجنب تبقى
      // حقولًا منفصلة يقدر المستخدم تعبئتها يدويًا في الحالتين.
      final linked = _workOrderId != null;
      await context.read<AppState>().recordBatchCloud(
            lineId: widget.line.id,
            batchNumber: _batchNumberCtrl.text.trim(),
            productName: _productCtrl.text.trim(),
            quantity: int.parse(_qtyCtrl.text.trim()),
            occurredAt: occurredAt,
            workOrderId: _workOrderId,
            hasStoppage: linked ? true : _hasStoppage,
            stoppageReason: !linked && _hasStoppage ? _reasonCtrl.text.trim() : null,
            stoppageMinutes: !linked && _hasStoppage ? int.tryParse(_minutesCtrl.text.trim()) : null,
            operationalNotes:
                _operationalNotesCtrl.text.trim().isNotEmpty ? _operationalNotesCtrl.text.trim() : null,
            actionsTaken: (linked || _hasStoppage) && _actionsTakenCtrl.text.trim().isNotEmpty
                ? _actionsTakenCtrl.text.trim()
                : null,
            workersCount: int.tryParse(_workersCtrl.text.trim()),
            timeFrom: _timeOfDayToString(_timeFrom),
            timeTo: _timeOfDayToString(_timeTo),
            preventionMethods: (linked || _hasStoppage) && _preventionMethodsCtrl.text.trim().isNotEmpty
                ? _preventionMethodsCtrl.text.trim()
                : null,
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم تسجيل الباتش وحفظه على السيرفر')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر تسجيل الباتش: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final workOrders = context.watch<AppState>().openWorkOrdersForLinking;
    return Scaffold(
      appBar: ScreenTopBar(title: 'باتش جديد — ${widget.line.name}'),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TabBar(
            controller: _tabController,
            labelColor: AppColors.production,
            unselectedLabelColor: AppColors.textMuted,
            indicatorColor: AppColors.production,
            tabs: const [
              Tab(text: 'بيانات الباتش'),
              Tab(text: 'الملاحظات التشغيلية'),
            ],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabController,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                  child: ListView(
                    children: [
                      const _Label('تاريخ الباتش'),
                      OutlinedButton.icon(
                        onPressed: _pickDate,
                        icon: const Icon(Icons.event_outlined, size: 18),
                        label: Text(ArabicFormat.date(_occurredDate)),
                        style: OutlinedButton.styleFrom(alignment: Alignment.centerRight),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'افتراضيًا اليوم — غيّره فقط لو تسجّل باتشًا نُسي تسجيله في وقته.',
                        style: TextStyle(fontSize: 11.5, color: AppColors.textMuted, height: 1.5),
                      ),
                      const SizedBox(height: 14),
                      const _Label('رقم الباتش'),
                      TextField(
                        controller: _batchNumberCtrl,
                        decoration: _decoration(hint: 'مثال: B-2026-0145'),
                        onChanged: (_) => setState(() {}),
                      ),
                      const SizedBox(height: 14),
                      const _Label('اسم المنتج'),
                      TextField(controller: _productCtrl, decoration: _decoration(hint: 'مثال: حديد تسليح ١٢ مم'), onChanged: (_) => setState(() {})),
                      const SizedBox(height: 14),
                      const _Label('الكمية'),
                      TextField(
                        controller: _qtyCtrl,
                        keyboardType: TextInputType.number,
                        decoration: _decoration(hint: 'مثال: 310'),
                        onChanged: (_) => setState(() {}),
                      ),
                      const SizedBox(height: 14),
                      const _Label('عدد العمال'),
                      TextField(
                        controller: _workersCtrl,
                        keyboardType: TextInputType.number,
                        decoration: _decoration(hint: 'مثال: 12'),
                        onChanged: (_) => setState(() {}),
                      ),
                      const SizedBox(height: 14),
                      const _Label('وقت البدء / الانتهاء الفعلي (اختياري)'),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => _pickTime(true),
                              child: Text(_timeFrom != null ? 'من: ${_timeFrom!.format(context)}' : 'وقت البدء'),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => _pickTime(false),
                              child: Text(_timeTo != null ? 'إلى: ${_timeTo!.format(context)}' : 'وقت الانتهاء'),
                            ),
                          ),
                        ],
                      ),
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
                          ...workOrders.map(
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
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: const [
                                    Text('هل حدث توقف أثناء هذا الباتش؟', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                                    Text('فعّل الخيار فقط عند وجود توقف فعلي', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                                  ],
                                ),
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
                        TextField(controller: _reasonCtrl, decoration: _decoration(hint: 'مثال: عطل ميكانيكي مفاجئ'), onChanged: (_) => setState(() {})),
                        const SizedBox(height: 14),
                        const _Label('مدة التوقف (بالدقائق)'),
                        TextField(controller: _minutesCtrl, keyboardType: TextInputType.number, decoration: _decoration(hint: 'مثال: 45')),
                      ],
                      if (_workOrderId != null || _hasStoppage) ...[
                        const SizedBox(height: 14),
                        const _Label('الحلول والإجراءات المتخذة'),
                        TextField(
                          controller: _actionsTakenCtrl,
                          maxLines: 3,
                          decoration: _decoration(hint: 'ما الذي تم اتخاذه لحل المشكلة؟'),
                        ),
                        const SizedBox(height: 14),
                        const _Label('طرق تجنّب تكرار المشكلة'),
                        TextField(
                          controller: _preventionMethodsCtrl,
                          maxLines: 3,
                          decoration: _decoration(hint: 'ما الذي سيُتَّبع لمنع تكرار هذا التوقف مستقبلاً؟'),
                        ),
                      ],
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                  child: ListView(
                    children: [
                      const _Label('الملاحظات التشغيلية'),
                      TextField(
                        controller: _operationalNotesCtrl,
                        maxLines: 6,
                        decoration: _decoration(hint: 'أي ملاحظات عن سير العمل خلال هذا الباتش — ليست مرتبطة بالضرورة بتوقف'),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator()))
                : PrimaryButton(
                    label: 'تسجيل الباتش',
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

// نص مختصر لعنصر أمر عمل ضمن قائمة الربط — اسم المعدة إن وُجد، وإلا مقتطف من
// الوصف (لأمر وقائي/مهمة بلا معدة محددة)، مع حالته الحالية.
String _workOrderLabel(MaintenanceReport r) {
  final title = r.equipment.isNotEmpty
      ? r.equipment
      : (r.description.length > 30 ? '${r.description.substring(0, 30)}…' : r.description);
  return '$title — ${maintenanceStatusLabel(r.status)}';
}

InputDecoration _decoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
