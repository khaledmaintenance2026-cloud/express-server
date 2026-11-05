import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/app_notification.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../services/notification_router.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// قائمة إشعارات المستخدم الحالي فقط — بلاغ عُيِّن له، إنجاز طلبه، طلب/رد
/// تصريح سلامة يخصّه. راجع /api/notifications على السيرفر. لا توجد إشعارات
/// نظام Push حقيقية بعد (تلك تحتاج ربط خدمة Firebase منفصلة)، لذا يستطلع
/// التطبيق هذه القائمة دوريًا (راجع AppState.attachAuth) وعند فتح الشاشة.
///
/// الضغط على أي إشعار يضعه "مقروءًا" ثم يفتح الشاشة المرتبطة به مباشرة (أمر
/// العمل، التصريح، تقرير الإصابة، أو تبويب القسم) — راجع
/// lib/services/notification_router.dart.
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  @override
  void initState() {
    super.initState();
    Future.microtask(() => context.read<AppState>().reloadNotifications());
  }

  IconData _iconFor(String? eventType) {
    switch (eventType) {
      case 'incident_created':
      case 'work_order_created':
        return Icons.warning_amber_outlined;
      case 'work_order_assigned':
        return Icons.build_outlined;
      case 'work_order_completed':
        return Icons.check_circle_outline;
      case 'safety_permit_requested':
        return Icons.assignment_outlined;
      case 'safety_permit_reviewed':
        return Icons.verified_user_outlined;
      default:
        return Icons.notifications_outlined;
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final notifications = state.notifications;

    return Scaffold(
      appBar: ScreenTopBar(
        title: 'الإشعارات',
        actions: [
          if (state.unreadNotificationsCount > 0)
            TextButton(
              onPressed: () => state.markAllNotificationsRead(),
              child: const Text('تحديد الكل كمقروء'),
            ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => state.reloadNotifications(),
        child: !state.notificationsLoaded && state.notificationsError == null
            ? const Center(child: CircularProgressIndicator())
            : notifications.isEmpty
                ? ListView(
                    children: const [
                      SizedBox(height: 120),
                      Center(child: Text('لا توجد إشعارات حتى الآن', style: TextStyle(color: AppColors.textMuted))),
                    ],
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 20),
                    itemCount: notifications.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) {
                      final n = notifications[i];
                      return _NotificationTile(
                        notification: n,
                        icon: _iconFor(n.eventType),
                        onTap: () {
                          state.markNotificationRead(n.id);
                          openNotificationTarget(context, n);
                        },
                      );
                    },
                  ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  final AppNotification notification;
  final IconData icon;
  final VoidCallback onTap;

  const _NotificationTile({required this.notification, required this.icon, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final unread = !notification.isRead;
    return InkWell(
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: unread ? AppColors.maintenance.withOpacity(0.05) : AppColors.surface,
          border: Border.all(color: unread ? AppColors.maintenance.withOpacity(0.3) : AppColors.border),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: AppColors.maintenance.withOpacity(0.12),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, size: 19, color: AppColors.maintenance),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          notification.title,
                          style: TextStyle(fontSize: 14, fontWeight: unread ? FontWeight.bold : FontWeight.w600),
                        ),
                      ),
                      if (unread)
                        Container(
                          width: 8,
                          height: 8,
                          decoration: const BoxDecoration(color: AppColors.maintenance, shape: BoxShape.circle),
                        ),
                    ],
                  ),
                  if (notification.body.trim().isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(notification.body, style: const TextStyle(fontSize: 13, color: AppColors.textSecondary), maxLines: 3, overflow: TextOverflow.ellipsis),
                  ],
                  const SizedBox(height: 6),
                  Text(ArabicFormat.dateTime(notification.createdAt), style: const TextStyle(fontSize: 11, color: AppColors.textFaint)),
                ],
              ),
            ),
            // سهم صغير يدل على أن الضغط على الإشعار يفتح الشاشة المرتبطة به
            if (notificationHasTarget(notification.eventType))
              const Padding(
                padding: EdgeInsets.only(right: 6, top: 8),
                child: Icon(Icons.chevron_left, size: 20, color: AppColors.textFaint),
              ),
          ],
        ),
      ),
    );
  }
}
