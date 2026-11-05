import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/supplier.dart';
import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة الموردين — سجل مستقل (اسم، جهة اتصال، هاتف، بريد، عنوان،
/// نشط/غير نشط) يُربط اختياريًا بأصناف كتالوج المخزون من نموذج الصنف. راجع
/// routes/inventory.js وschema.sql (جدول suppliers) للتفاصيل الكاملة.
/// القراءة متاحة لكل فريق المخزون، والإضافة/التعديل/الحذف مقصورة على من
/// يدير المخزون فقط (نفس تقييد كتالوج الأصناف — canManageInventory).
class InventorySuppliersScreen extends StatefulWidget {
  const InventorySuppliersScreen({super.key});

  @override
  State<InventorySuppliersScreen> createState() => _InventorySuppliersScreenState();
}

class _InventorySuppliersScreenState extends State<InventorySuppliersScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadSuppliers());
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final role = context.watch<AuthService>().currentUser?.role ?? AppRole.maintenanceTechnician;
    final canManage = canManageInventory(role);

    Widget body;
    if (!state.suppliersLoaded && state.suppliersError == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (state.suppliersError != null) {
      body = Center(
        child: Padding(padding: const EdgeInsets.all(20), child: InfoNote(text: state.suppliersError!, color: const Color(0xFFB3261E), icon: Icons.error_outline)),
      );
    } else if (state.suppliers.isEmpty) {
      body = Center(
        child: Text(canManage ? 'لا يوجد موردون بعد — اضغط "مورّد جديد" للإضافة' : 'لا يوجد موردون مسجَّلون بعد', style: const TextStyle(color: AppColors.textMuted)),
      );
    } else {
      body = RefreshIndicator(
        onRefresh: () => state.reloadSuppliers(),
        child: ListView.separated(
          itemCount: state.suppliers.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final s = state.suppliers[i];
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
                        if (s.contactName != null && s.contactName!.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(s.contactName!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
                        ],
                        if ((s.phone != null && s.phone!.isNotEmpty) || (s.email != null && s.email!.isNotEmpty)) ...[
                          const SizedBox(height: 4),
                          Text(
                            [if (s.phone != null && s.phone!.isNotEmpty) s.phone!, if (s.email != null && s.email!.isNotEmpty) s.email!].join('  •  '),
                            style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                          ),
                        ],
                        if (s.address != null && s.address!.isNotEmpty) ...[
                          const SizedBox(height: 4),
                          Text(s.address!, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
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
      appBar: const ScreenTopBar(title: 'الموردون'),
      body: Padding(padding: const EdgeInsets.fromLTRB(20, 12, 20, 16), child: body),
      floatingActionButton: canManage
          ? FloatingActionButton.extended(
              backgroundColor: AppColors.inventory,
              onPressed: () => _openForm(context),
              icon: const Icon(Icons.add, color: Colors.white),
              label: const Text('مورّد جديد', style: TextStyle(color: Colors.white)),
            )
          : null,
    );
  }

  Future<void> _openForm(BuildContext context, {Supplier? existing}) async {
    final appState = context.read<AppState>();
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final contactCtrl = TextEditingController(text: existing?.contactName ?? '');
    final phoneCtrl = TextEditingController(text: existing?.phone ?? '');
    final emailCtrl = TextEditingController(text: existing?.email ?? '');
    final addressCtrl = TextEditingController(text: existing?.address ?? '');
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
                  Text(existing == null ? 'إضافة مورّد جديد' : 'تعديل المورّد', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  const Align(alignment: Alignment.centerRight, child: Text('اسم المورّد', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: nameCtrl, decoration: fieldDecoration(hint: 'مثال: شركة القطع الصناعية'), onChanged: (_) => setSheetState(() {})),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('جهة الاتصال (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: contactCtrl, decoration: fieldDecoration()),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('الهاتف (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                            TextField(controller: phoneCtrl, keyboardType: TextInputType.phone, decoration: fieldDecoration()),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('البريد (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                            TextField(controller: emailCtrl, keyboardType: TextInputType.emailAddress, decoration: fieldDecoration()),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('العنوان (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: addressCtrl, decoration: fieldDecoration()),
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
                      title: const Text('مورّد نشط', style: TextStyle(fontSize: 13)),
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
                          label: existing == null ? 'إضافة المورّد' : 'حفظ التعديلات',
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
                                    final contactName = contactCtrl.text.trim().isEmpty ? null : contactCtrl.text.trim();
                                    final phone = phoneCtrl.text.trim().isEmpty ? null : phoneCtrl.text.trim();
                                    final email = emailCtrl.text.trim().isEmpty ? null : emailCtrl.text.trim();
                                    final address = addressCtrl.text.trim().isEmpty ? null : addressCtrl.text.trim();
                                    final notes = notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim();
                                    if (existing == null) {
                                      await appState.addSupplier(name: name, contactName: contactName, phone: phone, email: email, address: address, notes: notes);
                                    } else {
                                      await appState.updateSupplier(
                                        existing.id,
                                        name: name,
                                        contactName: contactName,
                                        phone: phone,
                                        email: email,
                                        address: address,
                                        active: active,
                                        notes: notes,
                                      );
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

  Future<void> _confirmDelete(BuildContext context, Supplier s) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف المورّد؟'),
        content: Text('سيُحذف "${s.name}" نهائيًا. الأصناف المرتبطة به تصبح بلا مورّد بدل رفض الحذف.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok == true) await appState.removeSupplier(s.id);
  }
}
