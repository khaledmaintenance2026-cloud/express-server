import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/production.dart';
import '../../services/app_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// إدارة معدات قسم إنتاج معيّن (إضافة/تعديل/حذف) — مرتبطة بمسارات
/// /production/equipment الموجودة فعليًا على سيرفر صيانتي المحلي (جدول
/// equipment). تُستخدم المعدة المُضافة هنا لاحقًا عند رفع بلاغ عطل (راجع
/// production_incidents_screen.dart) لإظهار اسم المعدة وكودها تلقائيًا في
/// رسالة واتساب "بلاغ عطل مفاجئ" بدل كتابتهما يدويًا كل مرة.
class ProductionEquipmentScreen extends StatefulWidget {
  final String facility;
  const ProductionEquipmentScreen({super.key, required this.facility});

  @override
  State<ProductionEquipmentScreen> createState() => _ProductionEquipmentScreenState();
}

class _ProductionEquipmentScreenState extends State<ProductionEquipmentScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadEquipment());
  }

  Future<void> _openForm(BuildContext context, {Equipment? existing}) async {
    final appState = context.read<AppState>();
    final lines = appState.linesByFacility(widget.facility);
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final codeCtrl = TextEditingController(text: existing?.code ?? '');
    // خطأ سابق: existing?.lineId ?? (lines.isNotEmpty ? lines.first.id : null)
    // كان يتعامل مع "معدة موجودة فعلاً بدون خط" بنفس معاملة "معدة جديدة" —
    // فيختار أول خط تلقائيًا ويُسنِد المعدة له بمجرد الضغط على "حفظ" حتى لو
    // كانت أصلاً "بدون خط محدد" عمدًا. الآن: نحترم حالة المعدة الحالية دائمًا
    // عند التعديل، والافتراضي (أول خط) يُستخدم فقط عند الإضافة الجديدة.
    String? selectedLineId = existing != null ? existing.lineId : (lines.isNotEmpty ? lines.first.id : null);
    bool submitting = false;
    String? error;

    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setSheetState) => Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(ctx).viewInsets.bottom),
          child: Container(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
            decoration: const BoxDecoration(
              color: AppColors.background,
              borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(existing == null ? 'إضافة معدة جديدة — ${widget.facility}' : 'تعديل المعدة',
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                const Align(alignment: Alignment.centerRight, child: Text('اسم المعدة', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                TextField(
                  controller: nameCtrl,
                  decoration: _decoration(hint: 'مثال: لمبة إضاءة'),
                  onChanged: (_) => setSheetState(() {}),
                ),
                const SizedBox(height: 12),
                const Align(alignment: Alignment.centerRight, child: Text('رقم الكود (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                TextField(controller: codeCtrl, decoration: _decoration(hint: 'مثال: 23')),
                const SizedBox(height: 12),
                const Align(alignment: Alignment.centerRight, child: Text('الخط المرتبط (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                DropdownButtonFormField<String?>(
                  value: selectedLineId,
                  decoration: _decoration(),
                  items: [
                    const DropdownMenuItem<String?>(value: null, child: Text('بدون خط محدد')),
                    ...lines.map((l) => DropdownMenuItem<String?>(value: l.id, child: Text(l.name))),
                  ],
                  onChanged: (v) => setSheetState(() => selectedLineId = v),
                ),
                if (error != null) ...[
                  const SizedBox(height: 10),
                  InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ],
                const SizedBox(height: 18),
                submitting
                    ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.production)))
                    : PrimaryButton(
                        label: existing == null ? 'إضافة المعدة' : 'حفظ التعديلات',
                        color: AppColors.production,
                        onPressed: nameCtrl.text.trim().isEmpty
                            ? null
                            : () async {
                                final name = nameCtrl.text.trim();
                                if (name.isEmpty) return;
                                setSheetState(() {
                                  submitting = true;
                                  error = null;
                                });
                                try {
                                  final code = codeCtrl.text.trim().isNotEmpty ? codeCtrl.text.trim() : null;
                                  if (existing == null) {
                                    await appState.addEquipmentCloud(name: name, lineId: selectedLineId, code: code, facility: widget.facility);
                                  } else {
                                    await appState.updateEquipmentCloud(existing.id, name: name, lineId: selectedLineId, code: code, facility: widget.facility);
                                  }
                                  if (ctx.mounted) Navigator.of(ctx).pop();
                                } catch (e) {
                                  setSheetState(() {
                                    submitting = false;
                                    error = 'تعذّر الحفظ: $e';
                                  });
                                }
                              },
                      ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, Equipment eq) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف المعدة؟'),
        content: Text('ستُحذف "${eq.name}" نهائيًا. البلاغات السابقة المرتبطة بها تبقى لكن بدون ربط.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok == true) await appState.removeEquipmentCloud(eq.id);
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final items = state.equipmentByFacility(widget.facility);

    return Scaffold(
      appBar: ScreenTopBar(title: 'معدات ${widget.facility}'),
      body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 14, 20, 90),
            child: RefreshIndicator(
              onRefresh: () => state.reloadEquipment(),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (state.equipmentError != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: InfoNote(text: state.equipmentError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                    ),
                  const Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      'تُستخدم هذه القائمة عند رفع بلاغ عطل — لإظهار اسم المعدة وكودها تلقائيًا بدل كتابتهما يدويًا',
                      style: TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                    ),
                  ),
                  const SizedBox(height: 14),
                  Expanded(
                    child: !state.equipmentLoaded && state.equipmentError == null
                        ? const Center(child: CircularProgressIndicator())
                        : items.isEmpty
                            ? const Center(child: Text('لا توجد معدات مسجّلة بعد — اضغط + للإضافة', style: TextStyle(color: AppColors.textMuted)))
                            : ListView.separated(
                                itemCount: items.length,
                                separatorBuilder: (_, __) => const SizedBox(height: 10),
                                itemBuilder: (context, i) {
                                  final eq = items[i];
                                  final lineMatches = eq.lineId != null
                                      ? state.productionLines.where((l) => l.id == eq.lineId)
                                      : const Iterable<ProductionLine>.empty();
                                  final lineName = lineMatches.isNotEmpty ? lineMatches.first.name : null;
                                  return Container(
                                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
                                    decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
                                    child: Row(
                                      children: [
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment: CrossAxisAlignment.start,
                                            children: [
                                              Text(eq.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                                              const SizedBox(height: 3),
                                              Text(
                                                [
                                                  if (eq.code != null && eq.code!.isNotEmpty) 'كود: ${eq.code}',
                                                  lineName ?? 'بدون خط محدد',
                                                ].join(' — '),
                                                style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                                              ),
                                            ],
                                          ),
                                        ),
                                        IconButton(
                                          icon: const Icon(Icons.edit_outlined, size: 19, color: AppColors.textMuted),
                                          onPressed: () => _openForm(context, existing: eq),
                                        ),
                                        IconButton(
                                          icon: const Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)),
                                          onPressed: () => _confirmDelete(context, eq),
                                        ),
                                      ],
                                    ),
                                  );
                                },
                              ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            bottom: 20,
            left: 20,
            child: FloatingActionButton(
              backgroundColor: AppColors.production,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
              onPressed: () => _openForm(context),
              child: const Icon(Icons.add, color: Colors.white),
            ),
          ),
        ],
      ),
    );
  }
}

InputDecoration _decoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.background,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
