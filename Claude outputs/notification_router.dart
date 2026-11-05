import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/app_notification.dart';
import '../models/maintenance_report.dart';
import '../models/safety_permit.dart';
import '../screens/maintenance/maintenance_assign_screen.dart';
import '../screens/maintenance/maintenance_report_print_screen.dart';
import '../screens/maintenance/maintenance_task_close_screen.dart';
import '../screens/safety/injury_report_detail_screen.dart';
import '../screens/safety/safety_approval_screen.dart';
import '../screens/safety/safety_permit_print_screen.dart';
import 'app_state.dart';
import 'auth_service.dart';

/// طلب تبديل تبويب القسم في الشريط السفلي (RootNav في main.dart). يضع هذا
/// الملف هنا اسم التبويب (مثل 'maintenance' أو 'inventory')، فيلتقطه RootNav
/// فورًا وينتقل للتبويب ثم يعيد القيمة إلى null. أسماء التبويبات هي نفسها
/// المعرّفة في RootNav._buildKeys: home / maintenance / inventory / production
/// / safety / admin.
final ValueNotifier<String?> moduleRequest = ValueNotifier<String?>(null);

// أنواع الإشعارات (event_type) كما يرسلها السيرفر من services/notifications.js
const Set<String> _workOrderEvents = {
  'work_order_created',
  'work_order_assigned',
  'work_order_completed',
  'work_order_updated',
};
const Set<String> _permitEvents = {
  'safety_permit_requested',
  'safety_permit_reviewed',
};
const Set<String> _inventoryEvents = {
  'part_request_created',
  'part_request_designed',
  'part_request_issued',
  'part_request_returned',
  'custody_assigned',
  'custody_returned',
};

/// هل لهذا النوع من الإشعارات شاشة يفتحها عند الضغط عليه؟ (يُستخدم فقط لإظهار
/// سهم صغير على بطاقة الإشعار في قائمة الإشعارات).
bool notificationHasTarget(String? eventType) {
  if (eventType == null) return false;
  return eventType == 'incident_created' ||
      eventType == 'injury_report_created' ||
      _workOrderEvents.contains(eventType) ||
      _permitEvents.contains(eventType) ||
      _inventoryEvents.contains(eventType);
}

/// يفتح الشاشة المناسبة لإشعار ضغط عليه المستخدم:
///  - أوامر العمل: شاشة التعيين / الإنجاز / التقرير حسب حالة أمر العمل (نفس ما
///    تفعله بطاقة أمر العمل في لوحة الصيانة)، وللأدوار خارج الصيانة (مثل مشرف
///    الإنتاج الذي رفع البلاغ) نافذة ملخص للقراءة فقط.
///  - تصاريح السلامة: شاشة المراجعة لو ما زال بانتظار القرار، وإلا تقرير التصريح.
///  - تقرير الإصابة: شاشة تفاصيل التقرير.
///  - بلاغ عطل من الإنتاج / طلبات القطع / العهد: ينتقل لتبويب القسم المناسب.
Future<void> openNotificationTarget(BuildContext context, AppNotification n) async {
  final type = n.eventType;
  final refId = n.refId;
  final navigator = Navigator.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final state = context.read<AppState>();
  final role = context.read<AuthService>().currentUser?.role;

  void say(String text) {
    messenger.showSnackBar(SnackBar(content: Text(text)));
  }

  if (type == null) return;

  if (type == 'incident_created') {
    _switchModule(navigator, 'maintenance');
    return;
  }

  if (_inventoryEvents.contains(type)) {
    _switchModule(navigator, 'inventory');
    return;
  }

  if (type == 'work_order_deleted') {
    say('حُذف هذا العمل من النظام ولم يعد متاحًا');
    return;
  }

  if (type == 'work_order_technician_removed') {
    say('تمت إزالتك من هذا العمل ولم يعد ضمن مهامك');
    return;
  }

  if (refId == null || refId.isEmpty) return;

  if (type == 'injury_report_created') {
    navigator.push(MaterialPageRoute(builder: (_) => InjuryReportDetailScreen(reportId: refId)));
    return;
  }

  if (_permitEvents.contains(type)) {
    await _openPermit(navigator, state, refId, say);
    return;
  }

  if (_workOrderEvents.contains(type)) {
    await _openWorkOrder(context, navigator, state, role, refId, say);
    return;
  }
}

/// يغلق كل الشاشات المفتوحة فوق الشاشة الرئيسية (ومنها شاشة الإشعارات) ثم
/// يطلب من RootNav الانتقال لتبويب القسم المطلوب.
void _switchModule(NavigatorState navigator, String key) {
  navigator.popUntil((route) => route.isFirst);
  moduleRequest.value = key;
}

SafetyPermit? _findPermit(AppState state, String id) {
  for (final p in state.permits) {
    if (p.id == id) return p;
  }
  return null;
}

Future<void> _openPermit(
  NavigatorState navigator,
  AppState state,
  String refId,
  void Function(String) say,
) async {
  SafetyPermit? permit = _findPermit(state, refId);
  if (permit == null) {
    await state.reloadPermits();
    permit = _findPermit(state, refId);
  }
  if (!navigator.mounted) return;
  if (permit == null) {
    say('تعذّر العثور على هذا التصريح (ربما حُذف)');
    return;
  }
  final SafetyPermit target = permit;
  // بانتظار القرار: شاشة المراجعة (قبول/رفض). تمت مراجعته: التقرير الكامل.
  final Widget screen = target.status == PermitStatus.pending
      ? SafetyApprovalScreen(permit: target)
      : SafetyPermitPrintScreen(permit: target);
  navigator.push(MaterialPageRoute(builder: (_) => screen));
}

MaintenanceReport? _findReport(AppState state, String id) {
  for (final r in state.maintenanceReports) {
    if (r.id == id) return r;
  }
  return null;
}

Future<void> _openWorkOrder(
  BuildContext context,
  NavigatorState navigator,
  AppState state,
  AppRole? role,
  String refId,
  void Function(String) say,
) async {
  MaintenanceReport? report = _findReport(state, refId);
  if (report == null) {
    try {
      report = await state.fetchWorkOrderDetail(refId);
    } catch (_) {
      report = null;
    }
  }
  if (!navigator.mounted) return;
  if (report == null) {
    say('تعذّر العثور على هذا العمل (ربما حُذف)');
    return;
  }
  final MaintenanceReport target = report;

  final bool isMaintenanceUser = role != null &&
      (role == AppRole.admin || isMaintenanceRole(role) || isInventoryOnlyRole(role));

  if (!isMaintenanceUser) {
    // مستخدم من خارج فريق الصيانة (مثل مشرف الإنتاج الذي رفع البلاغ): لا نفتح
    // له شاشات التعيين/الإنجاز، بل ملخصًا للقراءة فقط.
    if (!context.mounted) return;
    await _showWorkOrderSummary(context, target);
    return;
  }

  // التعيين (شاشة MaintenanceAssignScreen) لمسؤول الصيانة والمدير فقط (قرار
  // 2026-10-05) — الفني يصله إشعار بلاغ بانتظار التعيين أحيانًا، فنعرض له
  // ملخصًا للقراءة فقط بدل شاشة تعيين لا يملك صلاحيتها على السيرفر.
  if (target.status == MaintenanceStatus.pendingAssignment && (role == null || !canManageMaintenance(role))) {
    if (!context.mounted) return;
    await _showWorkOrderSummary(context, target);
    return;
  }

  // نفس ما تفعله بطاقة أمر العمل في لوحة الصيانة عند الضغط عليها تمامًا.
  final Widget screen = switch (target.status) {
    MaintenanceStatus.pendingAssignment => MaintenanceAssignScreen(report: target),
    MaintenanceStatus.inProgress => MaintenanceTaskCloseScreen(report: target),
    MaintenanceStatus.completed => MaintenanceReportPrintScreen(report: target),
  };
  navigator.push(MaterialPageRoute(builder: (_) => screen));
}

String _statusLabel(MaintenanceStatus s) {
  switch (s) {
    case MaintenanceStatus.pendingAssignment:
      return 'بانتظار تعيين فني';
    case MaintenanceStatus.inProgress:
      return 'قيد التنفيذ';
    case MaintenanceStatus.completed:
      return 'مكتمل';
  }
}

Future<void> _showWorkOrderSummary(BuildContext context, MaintenanceReport r) {
  final techs = r.technicianDisplayNames;
  final closeText = (r.closeDescription ?? '').trim();
  return showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('أمر العمل رقم ${r.id}', style: const TextStyle(fontSize: 16)),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${r.equipment} — ${r.line}', style: const TextStyle(fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            Text(r.description),
            const SizedBox(height: 10),
            Text('الحالة: ${_statusLabel(r.status)}'),
            if (techs != '—') ...[
              const SizedBox(height: 4),
              Text('الفنيون: $techs'),
            ],
            if (closeText.isNotEmpty) ...[
              const SizedBox(height: 10),
              const Text('بيان العمل المنجز:', style: TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 2),
              Text(closeText),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('إغلاق')),
      ],
    ),
  );
}
