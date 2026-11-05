import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../auth/change_password_screen.dart';
import '../notifications/notifications_screen.dart';

class HomeScreen extends StatelessWidget {
  final AppRole role;
  final ValueChanged<String>? onSelectModule;

  const HomeScreen({super.key, required this.role, this.onSelectModule});

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final auth = context.watch<AuthService>();
    final openReports = state.openEmergencyReports.length;
    final activeLines = state.productionLines.where((l) => l.activeToday).length;
    final pendingPermits = state.permits.where((p) => p.status.name == 'pending').length;
    final lowStockItems = state.inventoryItems.where((i) => i.isLow).length;

    final showMaintenance = role == AppRole.admin || isMaintenanceRole(role);
    // "المخزون" بطاقة مستقلة الآن (تبويب مستقل — راجع inventory_dashboard_screen.dart
    // وmain.dart)، لكنها تبقى مقصورة على فريق الصيانة والمخزون فقط (فني/مسؤول
    // صيانة، مسؤول المخزون، المصمم) بقرار من الإدارة رغم استقلاليتها.
    final showInventory = role == AppRole.admin || isMaintenanceRole(role) || isInventoryOnlyRole(role);
    final showProduction = role == AppRole.admin || isProductionRole(role);
    final showSafety = role == AppRole.admin || role == AppRole.safety;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const ChangePasswordScreen()),
                  ),
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(Icons.lock_outline, size: 19, color: AppColors.textSecondary),
                  ),
                ),
                const SizedBox(width: 8),
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const NotificationsScreen()),
                  ),
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        const Center(child: Icon(Icons.notifications_outlined, size: 19, color: AppColors.textSecondary)),
                        if (state.unreadNotificationsCount > 0)
                          Positioned(
                            top: -2,
                            right: -2,
                            child: Container(
                              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                              decoration: BoxDecoration(color: const Color(0xFFB3261E), borderRadius: BorderRadius.circular(8)),
                              constraints: const BoxConstraints(minWidth: 16),
                              child: Text(
                                state.unreadNotificationsCount > 9 ? '٩+' : '${state.unreadNotificationsCount}',
                                textAlign: TextAlign.center,
                                style: const TextStyle(fontSize: 9.5, color: Colors.white, fontWeight: FontWeight.bold),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                InkWell(
                  borderRadius: BorderRadius.circular(12),
                  onTap: () => auth.signOut(),
                  child: Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      border: Border.all(color: AppColors.border),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Icon(Icons.logout, size: 19, color: AppColors.textSecondary),
                  ),
                ),
                const Spacer(),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const Text('مرحباً بك', style: TextStyle(fontSize: 13, color: AppColors.textMuted)),
                    Text(auth.currentUser?.name ?? '', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    Text(roleLabel(role), style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 18),
            const Align(
              alignment: Alignment.centerRight,
              child: Text('الأقسام', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
            ),
            const SizedBox(height: 12),
            if (showMaintenance) ...[
              _ModuleCard(
                icon: Icons.build_outlined,
                color: AppColors.maintenance,
                title: 'الصيانة',
                subtitle: '$openReports بلاغات مفتوحة الآن',
                onTap: () => onSelectModule?.call('maintenance'),
              ),
              const SizedBox(height: 12),
            ],
            if (showInventory) ...[
              _ModuleCard(
                icon: Icons.inventory_2_outlined,
                color: AppColors.inventory,
                title: 'المخزون',
                subtitle: lowStockItems > 0 ? '$lowStockItems أصناف منخفضة' : 'المخزون بحالة جيدة',
                onTap: () => onSelectModule?.call('inventory'),
              ),
              const SizedBox(height: 12),
            ],
            if (showProduction) ...[
              _ModuleCard(
                icon: Icons.factory_outlined,
                color: AppColors.production,
                title: 'الإنتاج',
                subtitle: '$activeLines خطوط إنتاج نشطة',
                onTap: () => onSelectModule?.call('production'),
              ),
              const SizedBox(height: 12),
            ],
            if (showSafety) ...[
              _ModuleCard(
                icon: Icons.shield_outlined,
                color: AppColors.safety,
                iconColor: AppColors.safetyText,
                title: 'السلامة',
                subtitle: pendingPermits > 0 ? '$pendingPermits تصريح بانتظار الموافقة' : 'لا توجد تصاريح معلّقة',
                onTap: () => onSelectModule?.call('safety'),
              ),
              const SizedBox(height: 12),
            ],
            if (role == AppRole.admin)
              _ModuleCard(
                icon: Icons.admin_panel_settings_outlined,
                color: AppColors.textSecondary,
                title: 'الإدارة',
                subtitle: 'الفنيون واعتماد المستخدمين',
                onTap: () => onSelectModule?.call('admin'),
              ),
          ],
        ),
      ),
    );
  }
}

class _ModuleCard extends StatelessWidget {
  final IconData icon;
  final Color color;
  final Color? iconColor;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  const _ModuleCard({
    required this.icon,
    required this.color,
    this.iconColor,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(18),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
        ),
        child: Row(
          children: [
            Container(
              width: 52,
              height: 52,
              decoration: BoxDecoration(color: color.withOpacity(0.14), borderRadius: BorderRadius.circular(14)),
              child: Icon(icon, color: iconColor ?? color, size: 26),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 3),
                  Text(subtitle, style: const TextStyle(fontSize: 13, color: AppColors.textMuted)),
                ],
              ),
            ),
            const Icon(Icons.chevron_left, color: AppColors.textFaint),
          ],
        ),
      ),
    );
  }
}
