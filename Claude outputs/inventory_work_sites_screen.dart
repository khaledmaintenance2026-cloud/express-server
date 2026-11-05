import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/work_site.dart';
import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة مواقع العمل — كيانات مُدارة (بدل نص حر) يُربط بها اختياريًا أصناف
/// كتالوج المخزون من نموذج الصنف. راجع routes/inventory.js وschema.sql
/// (جدول work_sites) للتفاصيل الكاملة. نفس تقييد الصلاحية المستخدم في شاشة
/// الموردين بالضبط (canManageInventory).
class InventoryWorkSitesScreen extends StatefulWidget {
  const InventoryWorkSitesScreen({super.key});

  @override
  State<InventoryWorkSitesScreen> createState() => _InventoryWorkSitesScreenState();
}

class _InventoryWorkSitesScreenState extends State<InventoryWorkSitesScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadWorkSites());
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final role = context.watch<AuthService>().currentUser?.role ?? AppRole.maintenanceTechnician;
    final canManage = canManageInventory(role);

    Widget body;
    if (!state.workSitesLoaded && state.workSitesError == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (state.workSitesError != null) {
      body = Center(
        child: Padding(padding: const EdgeInsets.all(20), child: InfoNote(text: state.workSitesError!, color: const Color(0xFFB3261E), icon: Icons.error_outline)),
      );
    } else if (state.workSites.isEmpty) {
      body = Center(
        child: Text(canManage ? 'لا توجد مواقع عمل بعد — اضغط "موقع جديد" للإضافة' : 'لا توجد مواقع عمل مسجَّلة بعد', style: const TextStyle(color: AppColors.textMuted)),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => state.reloadWorkSites(),
        child: ListView.separated(
          itemCount: state.workSites.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final s = state.workSites[i];
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(
                color: AppColors.surface,
                border: Border.all(color: AppColors.border),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text(s.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold))),
                            if (!s.active) const StatusPill(label: 'غير نشط', color: AppColors.textMuted, background: AppColors.divider),
                          ],
                        ),
                        if (s.notes != null && s.notes!.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(s.notes!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
                        ],
                      ],
                    ),
                  ),
                  if (canManage) ...[
                    IconButton(icon: const Icon(Icons.edit_outlined, size: 19, color: AppColors.textMuted), onPressed: () => _openForm(context, existing: s)),
                    IconButton(icon: const Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)), onPressed: () => _confirmDelete(context, s)),
                  ],
                ],
              ),
            );
          },
        ),
      );
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'مواقع العمل'),
      body: Padding(padding: const EdgeInsets.fromLTRB(20, 12, 20, 16), child: body),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              backgroundColor: AppColors.inventory,
              onPressed: () => _openForm(context),
              icon: const Icon(Icons.add, color: Colors.white),
              label: const Text('موقع جديد', style: TextStyle(color: Colors.white)),
            )
          : null,
    );
  }

  Future<void> _openForm(BuildContext context, {WorkSite? existing}) async {
    final appState = context.read<AppState>();
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final notesCtrl = TextEditingController(text: existing?.notes ?? '');
    bool active = existing?.active ?? true;
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
            decoration: const BoxDecoration(color: AppColors.background, borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(existing == null ? 'إضافة موقع عمل جديد' : 'تعديل موقع العمل', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  const Align(alignment: Alignment.centerRight, child: Text('اسم الموقع', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: nameCtrl, decoration: fieldDecoration(hint: 'مثال: مصنع العطور — الخط الأول'), onChanged: (_) => setSheetState(() {})),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: fieldDecoration()),
                  if (existing != null) ...[
                    const SizedBox(height: 8),
                    CheckboxListTile(
                      value: active,
                      onChanged: (v) => setSheetState(() => active = v ?? true),
                      controlAffinity: ListTileControlAffinity.leading,
                      contentPadding: EdgeInsets.zero,
                      title: const Text('موقع نشط', style: TextStyle(fontSize: 13)),
                      subtitle: const Text('تعطيله يخفيه من قوائم الاختيار الجديدة بلا حذف بياناته', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                    ),
                  ],
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 18),
                  submitting
                      ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                      : PrimaryButton(
                          label: existing == null ? 'إضافة الموقع' : 'حفظ التعديلات',
                          color: AppColors.inventory,
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
                                    final notes = notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim();
                                    if (existing == null) {
                                      await appState.addWorkSite(name: name, notes: notes);
                                    } else {
                                      await appState.updateWorkSite(existing.id, name: name, active: active, notes: notes);
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
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WorkSite s) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف موقع العمل؟'),
        content: Text('سيُحذف "${s.name}" نهائيًا. الأصناف المرتبطة به تصبح بلا موقع بدل رفض الحذف.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok == true) await appState.removeWorkSite(s.id);
  }
}
