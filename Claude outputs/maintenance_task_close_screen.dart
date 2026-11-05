import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'maintenance_assign_screen.dart';
import 'inventory_screen.dart';

class MaintenanceTaskCloseScreen extends StatefulWidget {
  final MaintenanceReport report;
  const MaintenanceTaskCloseScreen({super.key, required this.report});

  @override
  State<MaintenanceTaskCloseScreen> createState() => _MaintenanceTaskCloseScreenState();
}

class _MaintenanceTaskCloseScreenState extends State<MaintenanceTaskCloseScreen> {
  final _descCtrl = TextEditingController();
  final _partsCtrl = TextEditingController();
  final _notesCtrl = TextEditingController();
  Timer? _ticker;
  Duration _elapsed = Duration.zero;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _elapsed = DateTime.now().difference(widget.report.reportedAt);
    // عرض حي للمدة المنقضية — يحسبها التطبيق تلقائيًا من لحظة رفع البلاغ،
    // وليس على الفني إدخالها يدويًا.
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (!mounted) return;
      setState(() => _elapsed = DateTime.now().difference(widget.report.reportedAt));
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _descCtrl.dispose();
    _partsCtrl.dispose();
    _notesCtrl.dispose();
    super.dispose();
  }

  bool get _canClose => !_submitting && _descCtrl.text.trim().isNotEmpty && _partsCtrl.text.trim().isNotEmpty;

  Future<void> _close() async {
    if (!_canClose) return;
    setState(() => _submitting = true);
    try {
      await context.read<AppState>().closeReport(
            widget.report.id,
            closeDescription: _descCtrl.text.trim(),
            partsUsed: _partsCtrl.text.trim(),
            closeNotes: _notesCtrl.text.trim().isEmpty ? null : _notesCtrl.text.trim(),
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إنجاز البلاغ نهائيًا')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر إنجاز البلاغ: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ScreenTopBar(
        title: 'إغلاق البلاغ',
        actions: [
          // رابط سريع لطلب قطعة من "المخزون" (تبويب مستقل الآن، راجع
          // inventory_dashboard_screen.dart) مربوطة تلقائيًا بهذا البلاغ —
          // الفني يطلب القطعة بدون مغادرة شاشة البلاغ أو التنقل لتبويب
          // آخر، والطلب يصل لمسؤول المخزون مربوطًا بأمر العمل نفسه (راجع
          // preselectedWorkOrder في openPartRequestSheet بـinventory_screen.dart).
          IconButton(
            icon: const Icon(Icons.inventory_2_outlined),
            tooltip: 'طلب قطعة لهذا البلاغ',
            onPressed: () => openPartRequestSheet(context, preselectedWorkOrder: widget.report),
          ),
          // يسمح بإضافة فني إضافي لهذا البلاغ نفسه أثناء العمل عليه (مثلًا
          // لو احتاج الفني المُسنَد مساعدة زميل) — تفتح نفس شاشة "تعيين فني"
          // المستخدمة أصلًا للتعيين الأول، وتُضيف فقط بلا أي مساس بالفني/
          // الفنيين المُسندين حاليًا (راجع maintenance_assign_screen.dart).
          IconButton(
            icon: const Icon(Icons.person_add_alt_1_outlined),
            tooltip: 'إضافة فني',
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => MaintenanceAssignScreen(report: widget.report)),
            ),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                children: [
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text('${widget.report.equipment} — ${widget.report.line}',
                            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 10),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Text('الوقت المستغرق حتى الآن', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                            Text(ArabicFormat.duration(_elapsed),
                                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.maintenance)),
                          ],
                        ),
                        const SizedBox(height: 2),
                        const Text('يُحسب تلقائيًا من لحظة رفع البلاغ — لا يحتاج إدخالًا يدويًا',
                            style: TextStyle(fontSize: 11.5, color: AppColors.textFaint)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 18),
                  Row(
                    children: [
                      const Text('وصف العمل المنجز', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _descCtrl,
                    minLines: 3,
                    maxLines: 5,
                    onChanged: (_) => setState(() {}),
                    decoration: _decoration(hint: 'مثال: تم إصلاح المحرك وتشغيله والتأكد من عدم وجود صوت غير طبيعي'),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      const Text('القطع / المواد المستخدمة', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _partsCtrl,
                    minLines: 2,
                    maxLines: 3,
                    onChanged: (_) => setState(() {}),
                    decoration: _decoration(hint: 'مثال: حلقة إحكام مقاس ٤٠مم × ١'),
                  ),
                  const SizedBox(height: 16),
                  const Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _notesCtrl,
                    minLines: 2,
                    maxLines: 3,
                    decoration: _decoration(hint: 'أي ملاحظات إضافية غير مشمولة في وصف العمل أعلاه'),
                  ),
                  const SizedBox(height: 16),
                  const InfoNote(
                    text: 'الإنجاز نهائي فور الضغط على الزر — بدون حاجة لاعتماد إضافي',
                    color: AppColors.successText,
                    icon: Icons.check_circle_outline,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(color: AppColors.successText)))
                : PrimaryButton(
                    label: 'إنجاز',
                    color: _canClose ? AppColors.successText : AppColors.textFaint,
                    icon: Icons.check,
                    onPressed: _canClose ? _close : null,
                  ),
          ],
        ),
      ),
    );
  }
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
