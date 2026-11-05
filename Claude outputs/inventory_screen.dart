import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';

import '../../models/custody.dart';
import '../../models/inventory.dart';
import '../../models/maintenance_report.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/auth_service.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// قسم "المخزون والقطع" — تبويب مستقل بالتنقل السفلي (فُصل عن لوحة الصيانة
/// لاحقًا، راجع inventory_dashboard_screen.dart وmain.dart)، وليس تبويبًا
/// فرعيًا داخلها كما كان سابقًا. يبقى مقصورًا على فريق الصيانة والمخزون فقط
/// (فني/مسؤول صيانة، مسؤول المخزون، المصمم) — قرار صريح من الإدارة ألا يُفتح
/// لبقية الأقسام (إنتاج/سلامة) رغم استقلاليته. يحوي كتالوج أصناف
/// [InventoryItem] وطلبات قطع [PartRequest] — راجع routes/inventory.js
/// وschema.sql لدورة الحالة الكاملة قبل تعديل هذا الملف: الفني يطلب ←
/// (اختياريًا) مصمم يرفع تصميمًا ← مسؤول المخزون يؤكد الصرف (هنا فقط يُخصم
/// الرصيد) ← إرجاع اختياري لو لم تُستخدم.
///
/// هذا الودجت [InventorySection] نفسه بلا Scaffold خاص به (محتوى قابل
/// للتضمين) — يُستخدم مباشرة من [InventoryDashboardScreen] في
/// inventory_dashboard_screen.dart الذي يضيف AppBar/Scaffold حوله.
/// أقسام تبويب "المخزون" الثلاثة — كتالوج الأصناف الاستهلاكية، طلبات
/// القطع، والعهدة (عدة/معدات تُسلَّم وتُرجَع، راجع models/custody.dart).
enum _InvTab { items, requests, custody }

class InventorySection extends StatefulWidget {
  const InventorySection({super.key});

  @override
  State<InventorySection> createState() => _InventorySectionState();
}

class _InventorySectionState extends State<InventorySection> {
  _InvTab _tab = _InvTab.items;
  String _categoryFilter = 'الكل';
  String _search = '';
  bool _showChart = false;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      context.read<AppState>().reloadInventoryItems();
      context.read<AppState>().reloadPartRequests();
      context.read<AppState>().reloadCustodyItems();
    });
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final currentUser = context.watch<AuthService>().currentUser;
    final role = currentUser?.role ?? AppRole.maintenanceTechnician;
    final canManage = canManageInventory(role);
    final canRequestParts = role == AppRole.admin || isMaintenanceRole(role);
    final canDesign = role == AppRole.admin || role == AppRole.maintenanceManager || isDesigner(role);

    final pendingDesignCount = state.partRequests.where((p) => p.status == PartRequestStatus.pendingDesign).length;
    final pendingIssueCount = state.partRequests.where((p) => p.status == PartRequestStatus.pendingIssue).length;
    final lowStockCount = state.inventoryItems.where((i) => i.isLow).length;
    // "المواد المستهلكة" — إجمالي كمية طلبات القطع المصروفة فعليًا (issued)
    // من قبل فريق الصيانة، عبر كل الوقت. قرار صريح من الإدارة: تبقى العهدة
    // (custody_items) مرتبطة محاسبيًا بالصيانة رغم استقلال تبويبها، وهذه
    // الإحصائية هي التعبير الملموس عن ذلك داخل تبويب المخزون نفسه.
    final consumedTotal = state.partRequests
        .where((p) => p.status == PartRequestStatus.issued)
        .fold<int>(0, (sum, p) => sum + p.quantity);
    final custodyOpenCount = state.custodyItems.where((c) => c.isAssigned).length;

    final categories = ['الكل', ...state.previousInventoryCategories];
    final catalog = state.inventoryItems.where((i) {
      if (_categoryFilter != 'الكل' && (i.category ?? '') != _categoryFilter) return false;
      if (_search.trim().isEmpty) return true;
      return i.name.toLowerCase().contains(_search.trim().toLowerCase());
    }).toList();

    return Stack(
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                KpiCard(value: ArabicFormat.number(state.inventoryItems.length), label: 'أصناف بالكتالوج', valueColor: AppColors.inventory),
                const SizedBox(width: 10),
                KpiCard(value: ArabicFormat.number(pendingIssueCount + pendingDesignCount), label: 'طلبات مفتوحة', valueColor: AppColors.inventory),
                const SizedBox(width: 10),
                KpiCard(
                  value: ArabicFormat.number(lowStockCount),
                  label: 'أصناف منخفضة',
                  valueColor: lowStockCount > 0 ? const Color(0xFFB3261E) : AppColors.inventory,
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                KpiCard(value: ArabicFormat.number(consumedTotal), label: 'مواد مستهلكة صرفتها الصيانة', valueColor: AppColors.inventory),
                const SizedBox(width: 10),
                KpiCard(value: ArabicFormat.number(custodyOpenCount), label: 'عهدة بحوزة فنيين الآن', valueColor: AppColors.inventory),
              ],
            ),
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(12)),
              child: Row(
                children: [
                  Expanded(
                    child: _InnerSegment(
                      label: 'الأصناف',
                      selected: _tab == _InvTab.items,
                      onTap: () => setState(() => _tab = _InvTab.items),
                    ),
                  ),
                  Expanded(
                    child: _InnerSegment(
                      label: 'طلبات القطع',
                      badge: pendingDesignCount + pendingIssueCount,
                      selected: _tab == _InvTab.requests,
                      onTap: () => setState(() => _tab = _InvTab.requests),
                    ),
                  ),
                  Expanded(
                    child: _InnerSegment(
                      label: 'العهدة',
                      selected: _tab == _InvTab.custody,
                      onTap: () => setState(() => _tab = _InvTab.custody),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            if (state.inventoryItemsError != null && _tab == _InvTab.items)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InfoNote(text: state.inventoryItemsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
              ),
            if (state.partRequestsError != null && _tab == _InvTab.requests)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InfoNote(text: state.partRequestsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
              ),
            if (state.custodyItemsError != null && _tab == _InvTab.custody)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: InfoNote(text: state.custodyItemsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
              ),
            if (_tab == _InvTab.items) ...[
              TextField(
                onChanged: (v) => setState(() => _search = v),
                decoration: InputDecoration(
                  hintText: 'ابحث عن صنف...',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  filled: true,
                  fillColor: AppColors.surface,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
                  enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
                ),
              ),
              if (categories.length > 1) ...[
                const SizedBox(height: 10),
                SizedBox(
                  height: 34,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: categories.length,
                    separatorBuilder: (_, __) => const SizedBox(width: 8),
                    itemBuilder: (context, i) {
                      final c = categories[i];
                      final selected = c == _categoryFilter;
                      return ChoiceChip(
                        label: Text(c, style: const TextStyle(fontSize: 12)),
                        selected: selected,
                        selectedColor: AppColors.inventory.withOpacity(0.16),
                        labelStyle: TextStyle(color: selected ? AppColors.inventory : AppColors.textSecondary, fontWeight: FontWeight.w600),
                        onSelected: (_) => setState(() => _categoryFilter = c),
                      );
                    },
                  ),
                ),
              ],
              if (state.inventoryItems.length > 1) ...[
                const SizedBox(height: 10),
                InkWell(
                  onTap: () => setState(() => _showChart = !_showChart),
                  borderRadius: BorderRadius.circular(10),
                  child: Row(
                    children: [
                      Icon(_showChart ? Icons.expand_less : Icons.bar_chart_outlined, size: 18, color: AppColors.inventory),
                      const SizedBox(width: 6),
                      Text('توزيع الأصناف حسب الفئة', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.inventory)),
                    ],
                  ),
                ),
                if (_showChart) ...[
                  const SizedBox(height: 8),
                  _CategoryDistributionChart(items: state.inventoryItems),
                ],
              ],
              const SizedBox(height: 10),
            ],
            Expanded(
              child: _tab == _InvTab.items
                  ? _buildCatalogList(context, catalog, canManage: canManage, canRequestParts: canRequestParts)
                  : (_tab == _InvTab.requests
                      ? _buildRequestsList(context, state, canManage: canManage, canDesign: canDesign, currentUserId: currentUser?.uid)
                      : _buildCustodyList(context, state, canManage: canManage)),
            ),
            const SizedBox(height: 64),
          ],
        ),
        Positioned(
          bottom: 4,
          left: 4,
          child: _tab == _InvTab.items
              ? (canManage
                  ? FloatingActionButton.extended(
                      heroTag: 'inv_add_item',
                      backgroundColor: AppColors.inventory,
                      onPressed: () => _openItemForm(context),
                      icon: const Icon(Icons.add, color: Colors.white),
                      label: const Text('صنف جديد', style: TextStyle(color: Colors.white)),
                    )
                  : const SizedBox.shrink())
              : (_tab == _InvTab.requests
                  ? (canRequestParts
                      ? FloatingActionButton.extended(
                          heroTag: 'inv_add_request',
                          backgroundColor: AppColors.inventory,
                          onPressed: () => openPartRequestSheet(context),
                          icon: const Icon(Icons.add, color: Colors.white),
                          label: const Text('طلب قطعة', style: TextStyle(color: Colors.white)),
                        )
                      : const SizedBox.shrink())
                  : (canManage
                      ? FloatingActionButton.extended(
                          heroTag: 'inv_add_custody',
                          backgroundColor: AppColors.inventory,
                          onPressed: () => _openCustodyItemForm(context),
                          icon: const Icon(Icons.add, color: Colors.white),
                          label: const Text('عدة جديدة', style: TextStyle(color: Colors.white)),
                        )
                      : const SizedBox.shrink())),
        ),
      ],
    );
  }

  Widget _buildCatalogList(BuildContext context, List<InventoryItem> items, {required bool canManage, required bool canRequestParts}) {
    final state = context.read<AppState>();
    if (!state.inventoryItemsLoaded && state.inventoryItemsError == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (items.isEmpty) {
      return Center(
        child: Text(
          canManage ? 'لا توجد أصناف بعد — اضغط "صنف جديد" للإضافة' : 'لا توجد أصناف مطابقة',
          style: const TextStyle(color: AppColors.textMuted),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => state.reloadInventoryItems(),
      child: ListView.separated(
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final item = items[i];
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              border: Border.all(color: item.isLow ? const Color(0xFFB3261E).withOpacity(0.4) : AppColors.border),
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
                          Expanded(child: Text(item.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold))),
                          if (item.isLow) const StatusPill(label: 'منخفض', color: Color(0xFFB3261E), background: Color(0x14B3261E)),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        [
                          if (item.category != null && item.category!.isNotEmpty) item.category!,
                          '${ArabicFormat.number(item.quantity)} ${item.unit}',
                        ].join(' — '),
                        style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                      ),
                      if ((item.supplierName != null && item.supplierName!.isNotEmpty) || (item.siteName != null && item.siteName!.isNotEmpty)) ...[
                        const SizedBox(height: 3),
                        Text(
                          [
                            if (item.supplierName != null && item.supplierName!.isNotEmpty) 'المورّد: ${item.supplierName}',
                            if (item.siteName != null && item.siteName!.isNotEmpty) 'الموقع: ${item.siteName}',
                          ].join('  •  '),
                          style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                        ),
                      ],
                    ],
                  ),
                ),
                if (canRequestParts)
                  IconButton(
                    tooltip: 'طلب هذه القطعة',
                    icon: const Icon(Icons.add_shopping_cart_outlined, size: 19, color: AppColors.inventory),
                    onPressed: () => openPartRequestSheet(context, preselected: item),
                  ),
                if (canManage) ...[
                  IconButton(
                    icon: const Icon(Icons.edit_outlined, size: 19, color: AppColors.textMuted),
                    onPressed: () => _openItemForm(context, existing: item),
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)),
                    onPressed: () => _confirmDeleteItem(context, item),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildRequestsList(
    BuildContext context,
    AppState state, {
    required bool canManage,
    required bool canDesign,
    required String? currentUserId,
  }) {
    if (!state.partRequestsLoaded && state.partRequestsError == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.partRequests.isEmpty) {
      return const Center(child: Text('لا توجد طلبات قطع بعد', style: TextStyle(color: AppColors.textMuted)));
    }
    return RefreshIndicator(
      onRefresh: () => state.reloadPartRequests(),
      child: ListView.separated(
        itemCount: state.partRequests.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) => _PartRequestCard(
          request: state.partRequests[i],
          canManage: canManage,
          canDesign: canDesign,
          // إلغاء الطلب متاح لصاحبه فقط (لو لم يُصرف بعد) أو لمن يدير المخزون
          // — بنفس القيد الملزم فعليًا على السيرفر (راجع DELETE
          // /part-requests/:id في routes/inventory.js). زر يظهر ثم يُرفض
          // بـ٤٠٣ تجربة استخدام سيئة، فنخفيه هنا مسبقًا بدل ذلك.
          canCancel: canManage || (currentUserId != null && state.partRequests[i].requestedByUserId == currentUserId),
          onDesign: () => _openDesignSheet(context, state.partRequests[i]),
          onIssue: () => _confirmIssue(context, state.partRequests[i]),
          onReturn: () => _confirmReturn(context, state.partRequests[i]),
          onCancel: () => _confirmCancelRequest(context, state.partRequests[i]),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------
  // نماذج/حوارات
  // -------------------------------------------------------------------

  Future<void> _openItemForm(BuildContext context, {InventoryItem? existing}) async {
    final appState = context.read<AppState>();
    final categories = appState.previousInventoryCategories;
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final categoryCtrl = TextEditingController(text: existing?.category ?? '');
    final unitCtrl = TextEditingController(text: existing?.unit ?? 'قطعة');
    final quantityCtrl = TextEditingController(text: (existing?.quantity ?? 0).toString());
    final minQuantityCtrl = TextEditingController(text: existing?.minQuantity?.toString() ?? '');
    final notesCtrl = TextEditingController(text: existing?.notes ?? '');
    String? supplierId = existing?.supplierId;
    String? siteId = existing?.siteId;
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
                  Text(existing == null ? 'إضافة صنف جديد' : 'تعديل الصنف', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  const Align(alignment: Alignment.centerRight, child: Text('اسم الصنف', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: nameCtrl, decoration: _fieldDecoration(hint: 'مثال: سير ناقل ٥ سم'), onChanged: (_) => setSheetState(() {})),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('الفئة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: categoryCtrl, decoration: _fieldDecoration(hint: 'مثال: قطع كهربائية')),
                  if (categories.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: categories
                          .map((c) => ActionChip(label: Text(c, style: const TextStyle(fontSize: 12)), onPressed: () => setSheetState(() => categoryCtrl.text = c)))
                          .toList(),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('وحدة القياس', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                            TextField(controller: unitCtrl, decoration: _fieldDecoration(hint: 'قطعة / متر / لتر')),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('الكمية الحالية', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                            TextField(controller: quantityCtrl, keyboardType: TextInputType.number, decoration: _fieldDecoration(hint: '0')),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  const Align(
                    alignment: Alignment.centerRight,
                    child: Text('الحد الأدنى للتنبيه (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  ),
                  const SizedBox(height: 6),
                  TextField(controller: minQuantityCtrl, keyboardType: TextInputType.number, decoration: _fieldDecoration(hint: 'مثال: ٥')),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('المورّد (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String?>(
                    value: supplierId,
                    decoration: _fieldDecoration(),
                    isExpanded: true,
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('بلا مورّد', style: TextStyle(color: AppColors.textMuted))),
                      ...appState.suppliers
                          .where((s) => s.active || s.id == supplierId)
                          .map((s) => DropdownMenuItem<String?>(value: s.id, child: Text(s.name, overflow: TextOverflow.ellipsis))),
                    ],
                    onChanged: (v) => setSheetState(() => supplierId = v),
                  ),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('موقع العمل (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String?>(
                    value: siteId,
                    decoration: _fieldDecoration(),
                    isExpanded: true,
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('بلا موقع', style: TextStyle(color: AppColors.textMuted))),
                      ...appState.workSites
                          .where((s) => s.active || s.id == siteId)
                          .map((s) => DropdownMenuItem<String?>(value: s.id, child: Text(s.name, overflow: TextOverflow.ellipsis))),
                    ],
                    onChanged: (v) => setSheetState(() => siteId = v),
                  ),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: _fieldDecoration()),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 18),
                  submitting
                      ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                      : PrimaryButton(
                          label: existing == null ? 'إضافة الصنف' : 'حفظ التعديلات',
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
                                    final qty = int.tryParse(quantityCtrl.text.trim()) ?? 0;
                                    final minQty = minQuantityCtrl.text.trim().isEmpty ? null : int.tryParse(minQuantityCtrl.text.trim());
                                    final category = categoryCtrl.text.trim().isEmpty ? null : categoryCtrl.text.trim();
                                    final unit = unitCtrl.text.trim().isEmpty ? 'قطعة' : unitCtrl.text.trim();
                                    final notes = notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim();
                                    if (existing == null) {
                                      await appState.addInventoryItem(
                                        name: name,
                                        category: category,
                                        unit: unit,
                                        quantity: qty,
                                        minQuantity: minQty,
                                        notes: notes,
                                        supplierId: supplierId,
                                        siteId: siteId,
                                      );
                                    } else {
                                      await appState.updateInventoryItem(
                                        existing.id,
                                        name: name,
                                        category: category,
                                        unit: unit,
                                        quantity: qty,
                                        minQuantity: minQty,
                                        notes: notes,
                                        supplierId: supplierId,
                                        siteId: siteId,
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

  Future<void> _confirmDeleteItem(BuildContext context, InventoryItem item) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف الصنف؟'),
        content: Text('سيُحذف "${item.name}" نهائيًا من الكتالوج.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok == true) await appState.removeInventoryItem(item.id);
  }

  Future<void> _openDesignSheet(BuildContext context, PartRequest request) async {
    final appState = context.read<AppState>();
    Uint8List? photoBytes;
    String? photoDataUrl;
    final notesCtrl = TextEditingController();
    bool submitting = false;
    String? error;

    Future<void> pickPhoto(BuildContext ctx, void Function(void Function()) setSheetState, ImageSource source) async {
      try {
        final picked = await ImagePicker().pickImage(source: source, maxWidth: 2000, imageQuality: 90);
        if (picked == null) return;
        final bytes = await picked.readAsBytes();
        final name = picked.name.toLowerCase();
        final ext = name.endsWith('.png') ? 'png' : (name.endsWith('.webp') ? 'webp' : 'jpeg');
        setSheetState(() {
          photoBytes = bytes;
          photoDataUrl = 'data:image/$ext;base64,${base64Encode(bytes)}';
        });
      } catch (e) {
        setSheetState(() => error = 'تعذّر اختيار الملف: $e');
      }
    }

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
                  Text('رفع تصميم — ${request.itemName}', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  InkWell(
                    onTap: () => showModalBottomSheet(
                      context: ctx,
                      builder: (sheetCtx) => SafeArea(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            ListTile(
                              leading: const Icon(Icons.photo_camera_outlined),
                              title: const Text('التقاط صورة بالكاميرا'),
                              onTap: () {
                                Navigator.of(sheetCtx).pop();
                                pickPhoto(ctx, setSheetState, ImageSource.camera);
                              },
                            ),
                            ListTile(
                              leading: const Icon(Icons.photo_library_outlined),
                              title: const Text('اختيار من المعرض'),
                              onTap: () {
                                Navigator.of(sheetCtx).pop();
                                pickPhoto(ctx, setSheetState, ImageSource.gallery);
                              },
                            ),
                          ],
                        ),
                      ),
                    ),
                    borderRadius: BorderRadius.circular(14),
                    child: Container(
                      height: 140,
                      decoration: BoxDecoration(
                        color: AppColors.surface,
                        border: Border.all(color: AppColors.border),
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: photoBytes == null
                          ? const Center(
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Icon(Icons.add_a_photo_outlined, size: 26, color: AppColors.textMuted),
                                  SizedBox(height: 6),
                                  Text('إرفاق ملف/صورة التصميم', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
                                ],
                              ),
                            )
                          : ClipRRect(
                              borderRadius: BorderRadius.circular(14),
                              child: Image.memory(photoBytes!, fit: BoxFit.cover, width: double.infinity),
                            ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ملاحظات التصميم (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: _fieldDecoration()),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 18),
                  submitting
                      ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                      : PrimaryButton(
                          label: 'رفع التصميم وإنهاء المهمة',
                          color: AppColors.inventory,
                          icon: Icons.upload_outlined,
                          onPressed: photoDataUrl == null
                              ? null
                              : () async {
                                  setSheetState(() {
                                    submitting = true;
                                    error = null;
                                  });
                                  try {
                                    await appState.submitPartDesign(
                                      request.id,
                                      designFileDataUrl: photoDataUrl!,
                                      designNotes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                                    );
                                    if (ctx.mounted) Navigator.of(ctx).pop();
                                  } catch (e) {
                                    setSheetState(() {
                                      submitting = false;
                                      error = 'تعذّر رفع التصميم: $e';
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

  Future<void> _confirmIssue(BuildContext context, PartRequest request) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('تأكيد صرف القطعة؟'),
        content: Text('سيُخصم "${request.itemName}" (الكمية: ${request.quantity}) من رصيد المخزون فورًا.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('تأكيد الصرف')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await appState.issuePartRequest(request.id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر تأكيد الصرف: $e')));
      }
    }
  }

  Future<void> _confirmReturn(BuildContext context, PartRequest request) async {
    final appState = context.read<AppState>();
    final notesCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إرجاع القطعة للمخزون؟'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('سيُعاد "${request.itemName}" (الكمية: ${request.quantity}) لرصيد المخزون — أُنجزت المهمة بدون استخدامها.'),
            const SizedBox(height: 10),
            TextField(controller: notesCtrl, decoration: const InputDecoration(hintText: 'سبب الإرجاع (اختياري)')),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('تأكيد الإرجاع')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await appState.returnPartRequest(request.id, returnNotes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim());
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر إرجاع القطعة: $e')));
      }
    }
  }

  Future<void> _confirmCancelRequest(BuildContext context, PartRequest request) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('إلغاء الطلب؟'),
        content: Text('سيُلغى طلب "${request.itemName}" نهائيًا.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('تراجع')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('إلغاء الطلب', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await appState.cancelPartRequest(request.id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر إلغاء الطلب: $e')));
      }
    }
  }

  // --------------------------------------------------------------------
  // "العهدة" — عدة ومعدات تُسلَّم لفني وتُرجَع لاحقًا (راجع models/custody.dart
  // وroutes/custody.js). قرار صريح من الإدارة: العهدة تبقى محاسبيًا جزءًا
  // من الصيانة رغم استقلال تبويب "المخزون" ككل — لذلك التسليم/الاسترجاع
  // مقصوران على من يدير المخزون (canManage) تمامًا كصرف/إرجاع طلب قطعة.
  // --------------------------------------------------------------------

  Widget _buildCustodyList(BuildContext context, AppState state, {required bool canManage}) {
    if (!state.custodyItemsLoaded && state.custodyItemsError == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.custodyItems.isEmpty) {
      return Center(
        child: Text(
          canManage ? 'لا توجد عهدة مسجّلة بعد — اضغط "عدة جديدة" للإضافة' : 'لا توجد عهدة مسجّلة بعد',
          style: const TextStyle(color: AppColors.textMuted),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: () => state.reloadCustodyItems(),
      child: ListView.separated(
        itemCount: state.custodyItems.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          final item = state.custodyItems[i];
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
            decoration: BoxDecoration(
              color: AppColors.surface,
              border: Border.all(color: item.isOverdue ? const Color(0xFFB3261E).withOpacity(0.4) : AppColors.border),
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(child: Text(item.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold))),
                              if (item.isAssigned)
                                StatusPill(
                                  label: item.isOverdue ? 'متأخرة' : 'بعهدة فني',
                                  color: item.isOverdue ? const Color(0xFFB3261E) : AppColors.inventory,
                                  background: item.isOverdue ? const Color(0x14B3261E) : AppColors.inventory.withOpacity(0.12),
                                )
                              else
                                const StatusPill(label: 'متاحة', color: AppColors.successText, background: Color(0x1400A76F)),
                            ],
                          ),
                          if ((item.category != null && item.category!.isNotEmpty) || (item.code != null && item.code!.isNotEmpty)) ...[
                            const SizedBox(height: 4),
                            Text(
                              [
                                if (item.category != null && item.category!.isNotEmpty) item.category!,
                                if (item.code != null && item.code!.isNotEmpty) 'كود: ${item.code}',
                              ].join(' — '),
                              style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                            ),
                          ],
                          if (item.isAssigned) ...[
                            const SizedBox(height: 6),
                            Text(
                              'بحوزة: ${item.currentHolder ?? '—'}'
                              '${item.currentExpectedReturnAt != null ? ' — الإرجاع المتوقع: ${ArabicFormat.date(item.currentExpectedReturnAt!)}' : ''}',
                              style: TextStyle(
                                fontSize: 12,
                                color: item.isOverdue ? const Color(0xFFB3261E) : AppColors.textMuted,
                                fontWeight: item.isOverdue ? FontWeight.w600 : FontWeight.normal,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (canManage) ...[
                      IconButton(
                        icon: const Icon(Icons.edit_outlined, size: 19, color: AppColors.textMuted),
                        onPressed: () => _openCustodyItemForm(context, existing: item),
                      ),
                      IconButton(
                        icon: const Icon(Icons.delete_outline, size: 19, color: Color(0xFFB3261E)),
                        onPressed: () => _confirmDeleteCustodyItem(context, item),
                      ),
                    ],
                  ],
                ),
                if (canManage) ...[
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: item.isAssigned
                        ? OutlinedButton.icon(
                            onPressed: () => _confirmReturnCustody(context, item),
                            icon: const Icon(Icons.assignment_return_outlined, size: 17),
                            label: const Text('استرجاع'),
                            style: OutlinedButton.styleFrom(foregroundColor: AppColors.inventory, side: const BorderSide(color: AppColors.inventory)),
                          )
                        : ElevatedButton.icon(
                            onPressed: () => _openAssignCustodySheet(context, item),
                            icon: const Icon(Icons.outbound_outlined, size: 17),
                            label: const Text('تسليم لفني'),
                            style: ElevatedButton.styleFrom(backgroundColor: AppColors.inventory, foregroundColor: Colors.white, elevation: 0),
                          ),
                  ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _openCustodyItemForm(BuildContext context, {CustodyItem? existing}) async {
    final appState = context.read<AppState>();
    final categories = appState.previousCustodyCategories;
    final nameCtrl = TextEditingController(text: existing?.name ?? '');
    final categoryCtrl = TextEditingController(text: existing?.category ?? '');
    final codeCtrl = TextEditingController(text: existing?.code ?? '');
    final notesCtrl = TextEditingController(text: existing?.notes ?? '');
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
                  Text(existing == null ? 'عدة جديدة' : 'تعديل العدة', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  const Align(alignment: Alignment.centerRight, child: Text('الاسم', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: nameCtrl, decoration: _fieldDecoration(hint: 'مثال: دريل كهربائي'), onChanged: (_) => setSheetState(() {})),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('الفئة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: categoryCtrl, decoration: _fieldDecoration(hint: 'مثال: عدة كهربائية')),
                  if (categories.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: categories
                          .map((c) => ActionChip(
                                label: Text(c, style: const TextStyle(fontSize: 11.5)),
                                onPressed: () => setSheetState(() => categoryCtrl.text = c),
                              ))
                          .toList(),
                    ),
                  ],
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('كود/رقم العهدة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: codeCtrl, decoration: _fieldDecoration(hint: 'مثال: TOOL-014')),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: _fieldDecoration()),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 18),
                  submitting
                      ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                      : PrimaryButton(
                          label: existing == null ? 'إضافة' : 'حفظ التعديلات',
                          color: AppColors.inventory,
                          icon: existing == null ? Icons.add : Icons.check,
                          onPressed: nameCtrl.text.trim().isEmpty
                              ? null
                              : () async {
                                  setSheetState(() {
                                    submitting = true;
                                    error = null;
                                  });
                                  try {
                                    if (existing == null) {
                                      await appState.addCustodyItem(
                                        name: nameCtrl.text.trim(),
                                        category: categoryCtrl.text.trim().isEmpty ? null : categoryCtrl.text.trim(),
                                        code: codeCtrl.text.trim().isEmpty ? null : codeCtrl.text.trim(),
                                        notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                                      );
                                    } else {
                                      await appState.updateCustodyItem(
                                        existing.id,
                                        name: nameCtrl.text.trim(),
                                        category: categoryCtrl.text.trim().isEmpty ? null : categoryCtrl.text.trim(),
                                        code: codeCtrl.text.trim().isEmpty ? null : codeCtrl.text.trim(),
                                        notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
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

  Future<void> _confirmDeleteCustodyItem(BuildContext context, CustodyItem item) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف العدة؟'),
        content: Text('سيُحذف "${item.name}" نهائيًا من سجل العهدة.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await appState.removeCustodyItem(item.id);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر الحذف: $e')));
      }
    }
  }

  Future<void> _openAssignCustodySheet(BuildContext context, CustodyItem item) async {
    final appState = context.read<AppState>();
    final technicians = appState.technicians;
    final openWorkOrders = appState.maintenanceReports.where((r) => r.status != MaintenanceStatus.completed).toList();

    String? selectedTechnicianId;
    final customNameCtrl = TextEditingController();
    String? selectedWorkOrderId;
    DateTime? expectedReturnAt;
    final notesCtrl = TextEditingController();
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
                  Text('تسليم "${item.name}"', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 16),
                  const Align(alignment: Alignment.centerRight, child: Text('الفني المستلم', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String?>(
                    value: selectedTechnicianId,
                    decoration: _fieldDecoration(),
                    isExpanded: true,
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('فني غير مسجّل بالقائمة (اكتب اسمه أدناه)')),
                      ...technicians.map((t) => DropdownMenuItem<String?>(value: t.id, child: Text(t.name))),
                    ],
                    onChanged: (v) => setSheetState(() => selectedTechnicianId = v),
                  ),
                  if (selectedTechnicianId == null) ...[
                    const SizedBox(height: 12),
                    const Align(alignment: Alignment.centerRight, child: Text('اسم الفني', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 6),
                    TextField(controller: customNameCtrl, decoration: _fieldDecoration(hint: 'اكتب اسم الفني المستلم'), onChanged: (_) => setSheetState(() {})),
                  ],
                  if (openWorkOrders.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    const Align(alignment: Alignment.centerRight, child: Text('ربط بأمر عمل مفتوح (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String?>(
                      value: selectedWorkOrderId,
                      decoration: _fieldDecoration(),
                      isExpanded: true,
                      items: [
                        const DropdownMenuItem<String?>(value: null, child: Text('بدون ربط')),
                        ...openWorkOrders.map((r) => DropdownMenuItem<String?>(value: r.id, child: Text('${r.equipment} — ${r.description}', overflow: TextOverflow.ellipsis))),
                      ],
                      onChanged: (v) => setSheetState(() => selectedWorkOrderId = v),
                    ),
                  ],
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('موعد الإرجاع المتوقع (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  InkWell(
                    borderRadius: BorderRadius.circular(13),
                    onTap: () async {
                      final picked = await showDatePicker(
                        context: ctx,
                        initialDate: expectedReturnAt ?? DateTime.now().add(const Duration(days: 1)),
                        firstDate: DateTime.now().subtract(const Duration(days: 1)),
                        lastDate: DateTime.now().add(const Duration(days: 365)),
                      );
                      if (picked != null) setSheetState(() => expectedReturnAt = picked);
                    },
                    child: InputDecorator(
                      decoration: _fieldDecoration(),
                      child: Row(
                        children: [
                          Expanded(child: Text(expectedReturnAt != null ? ArabicFormat.date(expectedReturnAt!) : 'بدون موعد محدد')),
                          if (expectedReturnAt != null)
                            IconButton(
                              icon: const Icon(Icons.close, size: 16),
                              onPressed: () => setSheetState(() => expectedReturnAt = null),
                            ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: _fieldDecoration()),
                  if (error != null) ...[
                    const SizedBox(height: 10),
                    InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                  ],
                  const SizedBox(height: 18),
                  submitting
                      ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                      : PrimaryButton(
                          label: 'تسليم',
                          color: AppColors.inventory,
                          icon: Icons.outbound_outlined,
                          onPressed: (selectedTechnicianId == null && customNameCtrl.text.trim().isEmpty)
                              ? null
                              : () async {
                                  setSheetState(() {
                                    submitting = true;
                                    error = null;
                                  });
                                  try {
                                    await appState.assignCustodyItem(
                                      itemId: item.id,
                                      technicianId: selectedTechnicianId,
                                      assignedToName: selectedTechnicianId == null ? customNameCtrl.text.trim() : null,
                                      workOrderId: selectedWorkOrderId,
                                      expectedReturnAt: expectedReturnAt,
                                      notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                                    );
                                    if (ctx.mounted) Navigator.of(ctx).pop();
                                  } catch (e) {
                                    setSheetState(() {
                                      submitting = false;
                                      error = 'تعذّر تسليم العهدة: $e';
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

  Future<void> _confirmReturnCustody(BuildContext context, CustodyItem item) async {
    final appState = context.read<AppState>();
    final notesCtrl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('استرجاع "${item.name}"؟'),
        content: TextField(
          controller: notesCtrl,
          minLines: 2,
          maxLines: 3,
          decoration: const InputDecoration(hintText: 'ملاحظات الاسترجاع (اختياري)', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('تراجع')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('استرجاع')),
        ],
      ),
    );
    if (ok != true) return;
    if (item.currentAssignmentId == null) return;
    try {
      await appState.returnCustodyItem(item.currentAssignmentId!, returnNotes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim());
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر الاسترجاع: $e')));
      }
    }
  }
}

/// يفتح نموذج "طلب قطعة جديد" — دالة عامة على مستوى الملف (وليست تابعة
/// لحالة [InventorySection]) حتى تُستدعى من أي مكان في التطبيق لديه سياق
/// (BuildContext) يملك Provider لـ[AppState]، وهذا متوفر عمليًا في كل
/// شاشة (المزوّد على مستوى التطبيق في main.dart) — تحديدًا تستدعيها الآن
/// أيضًا شاشة إنجاز البلاغ (maintenance_task_close_screen.dart) عبر زر
/// "طلب قطعة لهذا البلاغ" مع تمرير [preselectedWorkOrder]، بلا حاجة
/// للانتقال لتبويب "المخزون" المستقل أولًا — الفني يطلب القطعة من داخل
/// شاشة البلاغ مباشرة والطلب يصل مربوطًا بنفس البلاغ تلقائيًا.
Future<void> openPartRequestSheet(
  BuildContext context, {
  InventoryItem? preselected,
  MaintenanceReport? preselectedWorkOrder,
}) async {
  final appState = context.read<AppState>();
  final items = appState.inventoryItems;
  final openWorkOrders = [
    ...appState.maintenanceReports.where((r) => r.status != MaintenanceStatus.completed),
  ];
  if (preselectedWorkOrder != null && !openWorkOrders.any((r) => r.id == preselectedWorkOrder.id)) {
    openWorkOrders.insert(0, preselectedWorkOrder);
  }

  String? selectedItemId = preselected?.id;
  final customNameCtrl = TextEditingController();
  final quantityCtrl = TextEditingController(text: '1');
  final notesCtrl = TextEditingController();
  String? selectedWorkOrderId = preselectedWorkOrder?.id;
  bool needsDesign = false;
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
                const Text('طلب قطعة جديد', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                const SizedBox(height: 16),
                const Align(alignment: Alignment.centerRight, child: Text('الصنف من الكتالوج', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                DropdownButtonFormField<String?>(
                  value: selectedItemId,
                  decoration: _fieldDecoration(),
                  isExpanded: true,
                  items: [
                    const DropdownMenuItem<String?>(value: null, child: Text('قطعة غير موجودة بالكتالوج (اكتب اسمها أدناه)')),
                    ...items.map((i) => DropdownMenuItem<String?>(value: i.id, child: Text('${i.name} — متوفر: ${i.quantity} ${i.unit}'))),
                  ],
                  onChanged: (v) => setSheetState(() => selectedItemId = v),
                ),
                if (selectedItemId == null) ...[
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('اسم القطعة', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  TextField(controller: customNameCtrl, decoration: _fieldDecoration(hint: 'اكتب اسم القطعة المطلوبة'), onChanged: (_) => setSheetState(() {})),
                ],
                const SizedBox(height: 12),
                const Align(alignment: Alignment.centerRight, child: Text('الكمية', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                TextField(controller: quantityCtrl, keyboardType: TextInputType.number, decoration: _fieldDecoration()),
                if (openWorkOrders.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  const Align(alignment: Alignment.centerRight, child: Text('ربط بأمر عمل مفتوح (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String?>(
                    value: selectedWorkOrderId,
                    decoration: _fieldDecoration(),
                    isExpanded: true,
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('بدون ربط')),
                      ...openWorkOrders.map((r) => DropdownMenuItem<String?>(value: r.id, child: Text('${r.equipment} — ${r.description}', overflow: TextOverflow.ellipsis))),
                    ],
                    onChanged: (v) => setSheetState(() => selectedWorkOrderId = v),
                  ),
                ],
                const SizedBox(height: 12),
                CheckboxListTile(
                  value: needsDesign,
                  onChanged: (v) => setSheetState(() => needsDesign = v ?? false),
                  controlAffinity: ListTileControlAffinity.leading,
                  contentPadding: EdgeInsets.zero,
                  title: const Text('تحتاج القطعة تصميمًا قبل توفيرها', style: TextStyle(fontSize: 13)),
                  subtitle: const Text('تذهب أولًا للمصمم لرفع التصميم قبل صرفها', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                ),
                const Align(alignment: Alignment.centerRight, child: Text('ملاحظات (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))),
                const SizedBox(height: 6),
                TextField(controller: notesCtrl, minLines: 2, maxLines: 3, decoration: _fieldDecoration()),
                if (error != null) ...[
                  const SizedBox(height: 10),
                  InfoNote(text: error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
                ],
                const SizedBox(height: 18),
                submitting
                    ? const Center(child: Padding(padding: EdgeInsets.all(8), child: CircularProgressIndicator(color: AppColors.inventory)))
                    : PrimaryButton(
                        label: 'إرسال الطلب',
                        color: AppColors.inventory,
                        icon: Icons.send,
                        onPressed: (selectedItemId == null && customNameCtrl.text.trim().isEmpty)
                            ? null
                            : () async {
                                setSheetState(() {
                                  submitting = true;
                                  error = null;
                                });
                                try {
                                  final qty = int.tryParse(quantityCtrl.text.trim()) ?? 1;
                                  await appState.createPartRequest(
                                    itemId: selectedItemId,
                                    itemName: selectedItemId == null ? customNameCtrl.text.trim() : null,
                                    quantity: qty < 1 ? 1 : qty,
                                    workOrderId: selectedWorkOrderId,
                                    notes: notesCtrl.text.trim().isEmpty ? null : notesCtrl.text.trim(),
                                    needsDesign: needsDesign,
                                  );
                                  if (ctx.mounted) Navigator.of(ctx).pop();
                                } catch (e) {
                                  setSheetState(() {
                                    submitting = false;
                                    error = 'تعذّر إرسال الطلب: $e';
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

InputDecoration _fieldDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}

/// توزيع أصناف الكتالوج حسب الفئة — قائمة أشرطة نسبية بلون واحد فقط (لون
/// المخزون AppColors.inventory) بدرجة شفافية ثابتة، لا بتعدد الألوان — يطابق
/// هوية التطبيق البصرية التي تعتمد لونًا مميزًا واحدًا لكل قسم بدل الرسوم
/// البيانية متعددة الألوان التقليدية. بلا أي حزمة رسم بياني خارجية — Container
/// بسيط يكفي لهذا الغرض، ويطابق أسلوب التطبيق بلا تبعيات جديدة.
class _CategoryDistributionChart extends StatelessWidget {
  final List<InventoryItem> items;
  const _CategoryDistributionChart({required this.items});

  @override
  Widget build(BuildContext context) {
    final counts = <String, int>{};
    for (final i in items) {
      final c = (i.category != null && i.category!.trim().isNotEmpty) ? i.category!.trim() : 'غير مصنّف';
      counts[c] = (counts[c] ?? 0) + 1;
    }
    final total = items.length;
    final entries = counts.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    // أعلى ٦ فئات فقط، والباقي يُجمَع في "أخرى" حتى لا تطول القائمة بلا فائدة
    // لو كانت الفئات كثيرة جدًا.
    var shown = entries;
    if (entries.length > 6) {
      final top = entries.take(6).toList();
      final restTotal = entries.skip(6).fold<int>(0, (s, e) => s + e.value);
      shown = [...top, MapEntry('أخرى', restTotal)];
    }

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(14)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (int idx = 0; idx < shown.length; idx++) ...[
            Row(
              children: [
                Expanded(
                  child: Text(shown[idx].key, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis),
                ),
                const SizedBox(width: 8),
                Text(
                  '${ArabicFormat.number(shown[idx].value)} (${total == 0 ? 0 : (shown[idx].value * 100 / total).round()}٪)',
                  style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
                ),
              ],
            ),
            const SizedBox(height: 4),
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: LayoutBuilder(
                builder: (context, constraints) => Stack(
                  children: [
                    Container(height: 8, width: constraints.maxWidth, color: AppColors.divider),
                    Container(
                      height: 8,
                      width: constraints.maxWidth * (total == 0 ? 0.0 : shown[idx].value / total),
                      color: AppColors.inventory,
                    ),
                  ],
                ),
              ),
            ),
            if (idx != shown.length - 1) const SizedBox(height: 10),
          ],
        ],
      ),
    );
  }
}

class _InnerSegment extends StatelessWidget {
  final String label;
  final bool selected;
  final int badge;
  final VoidCallback onTap;

  const _InnerSegment({required this.label, required this.selected, required this.onTap, this.badge = 0});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(9),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(vertical: 9),
        decoration: BoxDecoration(
          color: selected ? AppColors.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          boxShadow: selected ? [BoxShadow(color: Colors.black.withOpacity(0.08), blurRadius: 3)] : null,
        ),
        alignment: Alignment.center,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: TextStyle(
                fontSize: 14,
                fontWeight: selected ? FontWeight.bold : FontWeight.w600,
                color: selected ? AppColors.inventory : AppColors.textMuted,
              ),
            ),
            if (badge > 0) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(color: const Color(0xFFB3261E), borderRadius: BorderRadius.circular(999)),
                child: Text(ArabicFormat.number(badge), style: const TextStyle(color: Colors.white, fontSize: 10.5, fontWeight: FontWeight.bold)),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _PartRequestCard extends StatelessWidget {
  final PartRequest request;
  final bool canManage;
  final bool canDesign;
  final bool canCancel;
  final VoidCallback onDesign;
  final VoidCallback onIssue;
  final VoidCallback onReturn;
  final VoidCallback onCancel;

  const _PartRequestCard({
    required this.request,
    required this.canManage,
    required this.canDesign,
    required this.canCancel,
    required this.onDesign,
    required this.onIssue,
    required this.onReturn,
    required this.onCancel,
  });

  @override
  Widget build(BuildContext context) {
    final statusInfo = switch (request.status) {
      PartRequestStatus.pendingDesign => (label: 'بانتظار التصميم', color: AppColors.warningText, bg: AppColors.warningBg),
      PartRequestStatus.pendingIssue => (label: 'بانتظار الصرف', color: AppColors.inventory, bg: AppColors.inventory.withOpacity(0.1)),
      PartRequestStatus.issued => (label: 'تم الصرف', color: AppColors.successText, bg: AppColors.successBg),
      PartRequestStatus.returned => (label: 'مرتجع', color: AppColors.textMuted, bg: AppColors.divider),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text('${request.itemName} × ${ArabicFormat.number(request.quantity)}', style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
              ),
              StatusPill(label: statusInfo.label, color: statusInfo.color, background: statusInfo.bg),
            ],
          ),
          const SizedBox(height: 6),
          Text('الطالب: ${request.requestedBy}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          if (request.workOrderDescription != null) Text('مرتبط بـ: ${request.workOrderDescription}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          if (request.notes != null && request.notes!.isNotEmpty) Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(request.notes!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
          ),
          if (request.designFileUrl != null) ...[
            const SizedBox(height: 8),
            PhotoThumbnailButton(url: '$kApiOrigin${request.designFileUrl}', height: 110),
          ],
          if (request.status == PartRequestStatus.pendingDesign && canDesign || request.status == PartRequestStatus.pendingIssue && canManage) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                if (request.status == PartRequestStatus.pendingDesign && canDesign)
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: onDesign,
                      icon: const Icon(Icons.brush_outlined, size: 16),
                      label: const Text('رفع التصميم'),
                    ),
                  ),
                if (request.status == PartRequestStatus.pendingIssue && canManage)
                  Expanded(
                    child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(backgroundColor: AppColors.inventory, foregroundColor: Colors.white),
                      onPressed: onIssue,
                      icon: const Icon(Icons.outbox_outlined, size: 16),
                      label: const Text('تأكيد الصرف'),
                    ),
                  ),
              ],
            ),
          ],
          if (request.status == PartRequestStatus.issued && canManage) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(onPressed: onReturn, icon: const Icon(Icons.undo, size: 16), label: const Text('إرجاع للمخزون')),
          ],
          if (canCancel && (request.status == PartRequestStatus.pendingDesign || request.status == PartRequestStatus.pendingIssue)) ...[
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(onPressed: onCancel, child: const Text('إلغاء الطلب', style: TextStyle(color: Color(0xFFB3261E), fontSize: 12))),
            ),
          ],
        ],
      ),
    );
  }
}
