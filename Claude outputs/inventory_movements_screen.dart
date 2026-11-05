import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/inventory.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة سجل حركات المخزون — سجل تدقيق دائم للمراجعة فقط (بلا أي تعديل من
/// هنا)، يعرض كل حركة أثّرت فعليًا على رصيد صنف: رصيد ابتدائي عند الإضافة،
/// تصحيح يدوي (جرد)، صرف طلب قطعة، أو إرجاعه. راجع routes/inventory.js
/// (GET /movements، logMovement) وschema.sql (جدول inventory_movements)
/// لشرح متى تُنشأ كل حركة على وجه الدقة.
class InventoryMovementsScreen extends StatefulWidget {
  const InventoryMovementsScreen({super.key});

  @override
  State<InventoryMovementsScreen> createState() => _InventoryMovementsScreenState();
}

class _InventoryMovementsScreenState extends State<InventoryMovementsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().loadInventoryMovements());
  }

  ({String label, Color color}) _typeInfo(InventoryMovementType type) {
    switch (type) {
      case InventoryMovementType.initialStock:
        return (label: 'رصيد ابتدائي', color: AppColors.successText);
      case InventoryMovementType.issue:
        return (label: 'صرف طلب قطعة', color: const Color(0xFFB3261E));
      case InventoryMovementType.returned:
        return (label: 'إرجاع طلب قطعة', color: AppColors.successText);
      case InventoryMovementType.adjustment:
        return (label: 'تصحيح يدوي', color: AppColors.inventory);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    Widget body;
    if (!state.inventoryMovementsLoaded && state.inventoryMovementsError == null) {
      body = const Center(child: CircularProgressIndicator());
    } else if (state.inventoryMovementsError != null) {
      body = Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: InfoNote(text: state.inventoryMovementsError!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
        ),
      );
    } else if (state.inventoryMovements.isEmpty) {
      body = const Center(child: Text('لا توجد حركات مسجّلة بعد', style: TextStyle(color: AppColors.textMuted)));
    } else {
      body = RefreshIndicator(
        onRefresh: () => state.loadInventoryMovements(),
        child: ListView.separated(
          itemCount: state.inventoryMovements.length,
          separatorBuilder: (_, __) => const SizedBox(height: 10),
          itemBuilder: (context, i) {
            final m = state.inventoryMovements[i];
            final info = _typeInfo(m.type);
            final deltaText = m.quantityDelta > 0 ? '+${ArabicFormat.number(m.quantityDelta)}' : ArabicFormat.number(m.quantityDelta);
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(child: Text(m.itemName, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold))),
                      StatusPill(label: info.label, color: info.color, background: info.color.withOpacity(0.1)),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    '$deltaText — الرصيد بعدها: ${ArabicFormat.number(m.quantityAfter)}',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: info.color),
                  ),
                  const SizedBox(height: 4),
                  Text('بواسطة: ${m.performedBy} — ${ArabicFormat.dateTime(m.createdAt)}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                  if (m.notes != null && m.notes!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(m.notes!, style: const TextStyle(fontSize: 12.5, color: AppColors.textSecondary)),
                    ),
                ],
              ),
            );
          },
        ),
      );
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'سجل حركة المخزون'),
      body: Padding(padding: const EdgeInsets.fromLTRB(20, 12, 20, 16), child: body),
    );
  }
}
