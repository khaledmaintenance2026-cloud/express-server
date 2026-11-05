import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/app_notification.dart';
import '../models/batch_edit.dart';
import '../models/custody.dart';
import '../models/injury_report.dart';
import '../models/inventory.dart';
import '../models/maintenance_report.dart';
import '../models/production.dart';
import '../models/safety_permit.dart';
import '../models/supplier.dart';
import '../models/technician.dart';
import '../models/work_site.dart';
import 'api_client.dart';

/// نتيجة طلب تقرير إنتاج بمدة مخصصة — الرابط دائمًا متاح لو نجح الإنشاء
/// (حتى لو فشل إرسال واتساب لسبب ما)، و[warning] يحمل سبب فشل الإرسال إن وُجد.
class ReportRequestResult {
  final String reportUrl;
  final bool whatsappSent;
  final String? warning;
  const ReportRequestResult({required this.reportUrl, required this.whatsappSent, this.warning});
}

/// طبقة الحالة/البيانات لكل التطبيق.
///
/// ⚠️ حالة كل قسم مختلفة الآن بعد الانتقال لسيرفر صيانتي المحلي:
/// - الفنيون (technicians)، خطوط الإنتاج (productionLines)، بلاغات الأعطال
///   (incidents)، باتشات الإنتاج (batches)، وبلاغات/أوامر عمل الصيانة
///   (maintenanceReports) مربوطون فعليًا بالسيرفر (Node.js + PostgreSQL) عبر
///   [ApiClient] — كل عملية هنا تُخزَّن فعليًا وتظهر لكل المستخدمين (لا حاجة
///   لأي إشعار فوري إضافي، البيانات تُحمَّل من جديد عند فتح/تحديث الشاشة).
/// - تصاريح السلامة (permits) أصبحت أيضًا مربوطة فعليًا بالسيرفر (راجع
///   routes/safetyPermits.js) — كانت بذاكرة محلية مؤقتة (Mock) تُمسح عند
///   إغلاق التطبيق ولا تصل لأي جهاز آخر ولا تُرسل واتساب حقيقيًا رغم أن
///   مسارات REST كانت جاهزة على السيرفر منذ فترة.
class AppState extends ChangeNotifier {
  final ApiClient _api = ApiClient.instance;

  // ---------------------------------------------------------------------
  // سجل نشاط مبسّط يحاكي الإشعارات الفورية + رسائل واتساب الجماعية،
  // لإظهار أن منطق سير العمل يعمل فعليًا (وليس مجرد تصميم ثابت). ملاحظة:
  // سيرفر صيانتي المحلي يملك بالفعل نظام Webhooks حقيقي (راجع تبويب
  // "إعدادات الموقع" في لوحة التحكم على السيرفر) يمكن ربطه بواتساب فعليًا
  // بدل هذا السجل الوهمي — راجع قسم التوصيات في تقرير المراجعة.
  // ---------------------------------------------------------------------
  final List<String> activityLog = [];

  void _log(String message) {
    activityLog.insert(0, message);
    if (activityLog.length > 50) activityLog.removeLast();
  }

  // ---------------------------------------------------------------------
  // الصيانة — الفنيون (مربوطون بالسيرفر المحلي فعليًا)
  // ---------------------------------------------------------------------
  final List<Technician> technicians = [];

  bool _attached = false;
  Timer? _notificationsTimer;
  Timer? _liveDataTimer;
  bool techniciansLoaded = false;
  String? techniciansError;

  /// تُستدعى مرة واحدة فور تسجيل الدخول بنجاح (راجع main.dart) — لا تحتاج
  /// أي رمز دخول يُمرَّر لها الآن؛ ApiClient يحمل رمز الجلسة الحالي داخليًا
  /// فور أن يستدعي AuthService.signIn/signUp عليه setToken.
  void attachAuth() {
    _attached = true;
    _loadTechniciansFromCloud();
    _loadProductionLinesFromCloud();
    _loadIncidentsFromCloud();
    _loadBatchesFromCloud();
    _loadWorkOrdersFromCloud();
    _loadPermitsFromCloud();
    _loadInventoryItemsFromCloud();
    _loadPartRequestsFromCloud();
    _loadSuppliersFromCloud();
    _loadWorkSitesFromCloud();
    _loadCustodyItemsFromCloud();
    _loadNotificationsFromCloud();
    // لا توجد إشعارات Push حقيقية بعد — نستطلع (Poll) قائمة الإشعارات كل ٤٥
    // ثانية طالما المستخدم مسجّل دخوله، حتى يظهر جرس الإشعارات محدَّثًا بلا
    // حاجة لإعادة فتح الشاشة يدويًا.
    _notificationsTimer?.cancel();
    _notificationsTimer = Timer.periodic(const Duration(seconds: 45), (_) => _loadNotificationsFromCloud());
    // بدون هذا، كل شاشة كانت تجلب بياناتها مرة واحدة فقط عند فتحها ولا
    // تتحدّث بعدها إطلاقًا إلا بسحب يدوي للتحديث أو بإغلاق الشاشة وإعادة
    // فتحها — فباتش جديد يُسجَّل من جوال زميل لا يظهر عندك إلا هكذا. الآن
    // تُعاد كل البيانات "الحيّة" (الفنيون، خطوط الإنتاج، البلاغات، الباتشات،
    // بلاغات/أوامر الصيانة، تصاريح السلامة) تلقائيًا كل ١٥ ثانية طالما
    // المستخدم مسجّل دخوله، بغض النظر عن الشاشة المفتوحة حاليًا.
    _liveDataTimer?.cancel();
    _liveDataTimer = Timer.periodic(const Duration(seconds: 15), (_) => _pollLiveData());
  }

  Future<void> _pollLiveData() async {
    if (!_attached) return;
    await Future.wait([
      _loadTechniciansFromCloud(),
      _loadProductionLinesFromCloud(),
      _loadEquipmentFromCloud(),
      _loadIncidentsFromCloud(),
      _loadBatchesFromCloud(),
      _loadWorkOrdersFromCloud(),
      _loadPermitsFromCloud(),
      _loadInventoryItemsFromCloud(),
      _loadPartRequestsFromCloud(),
      _loadCustodyItemsFromCloud(),
    ]);
  }

  void detachAuth() {
    _attached = false;
    techniciansLoaded = false;
    technicians.clear();
    productionLinesLoaded = false;
    productionLines.clear();
    equipmentLoaded = false;
    equipment.clear();
    incidentsLoaded = false;
    incidents.clear();
    batchesLoaded = false;
    batches.clear();
    workOrdersLoaded = false;
    maintenanceReports.clear();
    permitsLoaded = false;
    permits.clear();
    inventoryItemsLoaded = false;
    inventoryItems.clear();
    partRequestsLoaded = false;
    partRequests.clear();
    suppliersLoaded = false;
    suppliers.clear();
    workSitesLoaded = false;
    workSites.clear();
    inventoryMovementsLoaded = false;
    inventoryMovements.clear();
    custodyItemsLoaded = false;
    custodyItems.clear();
    notificationsLoaded = false;
    notifications.clear();
    _notificationsTimer?.cancel();
    _notificationsTimer = null;
    _liveDataTimer?.cancel();
    _liveDataTimer = null;
  }

  Future<void> reloadTechnicians() => _loadTechniciansFromCloud();

  Future<void> _loadTechniciansFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/technicians');
      final list = (data['technicians'] as List).cast<Map<String, dynamic>>();
      technicians
        ..clear()
        ..addAll(list.map(Technician.fromApi));
      techniciansLoaded = true;
      techniciansError = null;
      notifyListeners();
    } catch (e) {
      // نُبقي القائمة كما كانت (فارغة أو من تحميل سابق ناجح)، وتُعرض رسالة
      // الخطأ في لوحة الإدارة مع زر لإعادة المحاولة (reloadTechnicians).
      techniciansError = 'تعذّر تحميل الفنيين من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> addTechnicianCloud({
    required String name,
    required String specialty,
    String? phone,
  }) async {
    final data = await _api.post('/technicians', {
      'name': name,
      'specialty': specialty,
      if (phone != null && phone.isNotEmpty) 'phone': phone,
    });
    technicians.add(Technician.fromApi(data['technician'] as Map<String, dynamic>));
    notifyListeners();
  }

  Future<void> updateTechnicianCloud(
    String id, {
    String? name,
    String? specialty,
    String? phone,
    bool? available,
  }) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (specialty != null) body['specialty'] = specialty;
    if (phone != null) body['phone'] = phone;
    if (available != null) body['status'] = available ? 'available' : 'busy';
    if (body.isEmpty) return;

    final data = await _api.patch('/technicians/$id', body);
    final updated = Technician.fromApi(data['technician'] as Map<String, dynamic>);
    final i = technicians.indexWhere((t) => t.id == id);
    if (i != -1) technicians[i] = updated;
    notifyListeners();
  }

  Future<void> removeTechnicianCloud(String id) async {
    await _api.delete('/technicians/$id');
    technicians.removeWhere((t) => t.id == id);
    notifyListeners();
  }

  // ---------------------------------------------------------------------
  // الصيانة — البلاغات وأوامر العمل (مربوطة بالسيرفر المحلي فعليًا الآن عبر
  // /work-orders، بنفس نمط الفنيين/الإنتاج أعلاه). كانت بيانات وهمية محلية
  // على كل جهاز — تختفي عند إعادة تشغيل التطبيق، لا تصل لأي جهاز آخر، ولا
  // تُرسل أي إشعار واتساب حقيقي رغم أن الواجهة كانت تعرض نصًا يوحي بذلك.
  // ---------------------------------------------------------------------
  final List<MaintenanceReport> maintenanceReports = [];
  bool workOrdersLoaded = false;
  String? workOrdersError;

  Future<void> reloadWorkOrders() => _loadWorkOrdersFromCloud();

  Future<void> _loadWorkOrdersFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/work-orders');
      final list = (data['workOrders'] as List).cast<Map<String, dynamic>>();
      maintenanceReports
        ..clear()
        ..addAll(list.map(MaintenanceReport.fromApi));
      workOrdersLoaded = true;
      workOrdersError = null;
      notifyListeners();
    } catch (e) {
      workOrdersError = 'تعذّر تحميل بلاغات الصيانة من السيرفر: $e';
      notifyListeners();
    }
  }

  List<MaintenanceReport> get openEmergencyReports => maintenanceReports
      .where((r) => r.isEmergency && r.status != MaintenanceStatus.completed)
      .toList();

  /// الأعمال المنجزة فقط — منفصلة عن لوحة العمل اليومية حتى لا تتراكم فيها
  /// للأبد (راجع [deleteMaintenanceReport] لحذفها نهائيًا بعد أرشفتها/طباعتها).
  List<MaintenanceReport> get completedMaintenanceReports =>
      maintenanceReports.where((r) => r.status == MaintenanceStatus.completed).toList();

  /// يحذف بلاغًا/أمر عمل منجزًا نهائيًا — حذف حقيقي من قاعدة البيانات على
  /// السيرفر (وليس من هذا الجهاز فقط كما كان سابقًا)، فيختفي من كل الأجهزة.
  Future<void> deleteMaintenanceReport(String reportId) async {
    await _api.delete('/work-orders/$reportId');
    maintenanceReports.removeWhere((r) => r.id == reportId);
    notifyListeners();
  }

  /// بلاغ عطل طارئ جديد يرفعه الإنتاج — يُنشئ أمر عمل حقيقي على السيرفر
  /// (kind: emergency)، والسيرفر نفسه يرسل إشعار واتساب فوري لجروب الصيانة
  /// (راجع routes/workOrders.js و services/notifications.js).
  Future<MaintenanceReport> createReport({
    required String equipment,
    required String facility,
    required String description,
  }) async {
    final data = await _api.post('/work-orders', {
      'kind': 'emergency',
      'equipmentName': equipment,
      'facility': facility,
      'description': description,
    });
    final report = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    maintenanceReports.insert(0, report);
    _log('تم إرسال بلاغ عطل جديد: $equipment — $facility');
    notifyListeners();
    return report;
  }

  /// أمر عمل وقائي جديد يبادر به مشرف الصيانة، مع تعيين فني واحد له مباشرة —
  /// عمليتان متتاليتان على السيرفر (إنشاء ثم تعيين) لأن أمر العمل يُنشأ
  /// دائمًا بلا فني مُسنَد أولًا (راجع POST /work-orders)، لكن التطبيق يُظهر
  /// النتيجة النهائية فقط بعد اكتمال الاثنين معًا.
  Future<MaintenanceReport> createWorkOrder({
    required String facility,
    required String description,
    required List<String> technicianIds,
    int? reminderIntervalDays,
    String? equipmentCode,
  }) async {
    final createData = await _api.post('/work-orders', {
      'kind': 'preventive',
      'facility': facility,
      'description': description,
      if (reminderIntervalDays != null) 'reminderIntervalDays': reminderIntervalDays,
      if (equipmentCode != null && equipmentCode.trim().isNotEmpty) 'equipmentCode': equipmentCode.trim(),
    });
    final workOrderId = (createData['workOrder'] as Map<String, dynamic>)['id'].toString();
    final assignData = await _api.patch('/work-orders/$workOrderId/assign', {'technicianIds': technicianIds});
    final order = MaintenanceReport.fromApi(assignData['workOrder'] as Map<String, dynamic>);

    for (final id in technicianIds) {
      final techIdx = technicians.indexWhere((t) => t.id == id);
      if (techIdx != -1) technicians[techIdx].available = false;
    }

    maintenanceReports.insert(0, order);
    _log('تم إنشاء أمر عمل وقائي جديد — $facility');
    notifyListeners();
    return order;
  }

  /// "مهمة عمل" جديدة (داخلية/خارجية) — تصنيف ثالث منفصل تمامًا عن بلاغ العطل
  /// الطارئ والصيانة الوقائية (راجع isTask/taskScope في MaintenanceReport).
  /// تعيين الفنيين هنا اختياري: لو اختير فني واحد على الأقل، تُنشأ المهمة ثم
  /// تُسنَد فورًا فتبدأ "قيد التنفيذ" مباشرة (بنفس نمط createWorkOrder أعلاه
  /// تمامًا)؛ ولو لم يُختر أي فني، تبقى المهمة "بانتظار التعيين" كأي بلاغ عطل
  /// عادي، وتُسنَد لاحقًا من الشاشة المعتادة (MaintenanceAssignScreen).
  Future<MaintenanceReport> createMaintenanceTask({
    required String taskScope, // 'internal' | 'external'
    required String location,
    required String description,
    List<String> technicianIds = const [],
  }) async {
    final scopeLabel = taskScope == 'external' ? 'مهمة خارجية' : 'مهمة داخلية';
    final createData = await _api.post('/work-orders', {
      'kind': 'emergency',
      'isTask': true,
      'taskScope': taskScope,
      'equipmentName': scopeLabel,
      'facility': location,
      'description': description,
    });
    var order = MaintenanceReport.fromApi(createData['workOrder'] as Map<String, dynamic>);

    if (technicianIds.isNotEmpty) {
      final assignData = await _api.patch('/work-orders/${order.id}/assign', {'technicianIds': technicianIds});
      order = MaintenanceReport.fromApi(assignData['workOrder'] as Map<String, dynamic>);
      for (final id in technicianIds) {
        final techIdx = technicians.indexWhere((t) => t.id == id);
        if (techIdx != -1) technicians[techIdx].available = false;
      }
    }

    maintenanceReports.insert(0, order);
    _log('تم إنشاء مهمة عمل جديدة ($scopeLabel) — $location');
    notifyListeners();
    return order;
  }

  /// مواقع "مهام العمل" المستخدمة سابقًا (بلا تكرار) — تُعرض كاقتراحات سريعة
  /// عند إنشاء مهمة جديدة (راجع maintenance_new_report_screen.dart) بدل إجبار
  /// المستخدم على كتابة نفس الموقع من الصفر في كل مرة. لا علاقة لها بمواقع
  /// بلاغات الأعطال الفعلية (facility) — تُفلتَر هنا بـisTask فقط.
  List<String> get previousTaskLocations {
    final set = <String>{};
    for (final r in maintenanceReports) {
      if (r.isTask && r.line.trim().isNotEmpty) set.add(r.line.trim());
    }
    final list = set.toList()..sort();
    return list;
  }

  /// تعيين فني واحد أو أكثر لنفس البلاغ — يدعم النظام الآن أكثر من فني لنفس
  /// أمر العمل (راجع work_order_technicians على السيرفر).
  Future<void> assignTechnicians(String reportId, List<String> technicianIds) async {
    final data = await _api.patch('/work-orders/$reportId/assign', {'technicianIds': technicianIds});
    final updated = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    final i = maintenanceReports.indexWhere((r) => r.id == reportId);
    if (i != -1) maintenanceReports[i] = updated;
    // السيرفر يحدّث حالة كل فني إلى "مشغول" فعليًا ضمن نفس العملية — هذا فقط
    // تحديث محلي متفائل (Optimistic) ليظهر أثره فورًا بلا انتظار طلب تحميل
    // جديد للفنيين.
    for (final id in technicianIds) {
      final techIdx = technicians.indexWhere((t) => t.id == id);
      if (techIdx != -1) technicians[techIdx].available = false;
    }
    _log('تم إسناد بلاغ "${updated.equipment}" لـ ${updated.technicianDisplayNames}');
    notifyListeners();
  }

  /// تعديل بيانات مهمة/بلاغ قائم بعد الإنشاء (الوصف، الموقع، كود/اسم المعدة،
  /// نوع المهمة) — مقصور على مسؤول الصيانة/المدير على السيرفر (PATCH
  /// /work-orders/:id)، قرار صريح 2026-09-26. كل معامل اختياري: يُرسَل فقط
  /// لو مُرِّر فعليًا، فيتحقق تعديل جزئي (حقل واحد فقط مثلًا) بلا مساس بالباقي.
  Future<void> updateWorkOrder(
    String reportId, {
    String? description,
    String? facility,
    String? equipmentName,
    String? equipmentCode,
    String? taskScope,
  }) async {
    final body = <String, dynamic>{};
    if (description != null) body['description'] = description.trim();
    if (facility != null) body['facility'] = facility.trim();
    if (equipmentName != null) body['equipmentName'] = equipmentName.trim();
    if (equipmentCode != null) body['equipmentCode'] = equipmentCode.trim();
    if (taskScope != null) body['taskScope'] = taskScope;
    if (body.isEmpty) return;

    final data = await _api.patch('/work-orders/$reportId', body);
    final updated = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    final i = maintenanceReports.indexWhere((r) => r.id == reportId);
    if (i != -1) maintenanceReports[i] = updated;
    _log('تم تعديل بيانات "${updated.equipment}"');
    notifyListeners();
  }

  /// كل الفنيين المُسنَدين لمهمة/أمر عمل معيّن (معرّف + اسم + جوال) — يُستدعى
  /// فقط عند فتح شاشة تعديل المهمة (بعكس technicianDisplayNames الجاهز أصلًا
  /// على MaintenanceReport، وهو نص عرض فقط بلا معرّفات تصلح لإزالة فني بعينه).
  Future<List<Technician>> fetchWorkOrderTechnicians(String reportId) async {
    final data = await _api.get('/work-orders/$reportId/technicians');
    final list = (data['technicians'] as List<dynamic>? ?? [])
        .map((t) => Technician.fromApi(t as Map<String, dynamic>))
        .toList();
    return list;
  }

  /// إزالة فني واحد بعينه من مهمة/أمر عمل — بعكس [assignTechnicians] الذي
  /// يُضيف فقط ولا يقدر يزيل أحدًا. مقصور على مسؤول الصيانة/المدير على
  /// السيرفر (DELETE /work-orders/:id/technicians/:techId)، قرار صريح
  /// 2026-09-26. الفني المُزال يعود "متاح" فورًا (إلا لو كان مشغولًا فعليًا
  /// بأمر عمل آخر مفتوح — السيرفر يتحقق من هذا بنفسه).
  Future<void> removeTechnicianFromWorkOrder(String reportId, String technicianId) async {
    final data = await _api.delete('/work-orders/$reportId/technicians/$technicianId');
    final updated = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    final i = maintenanceReports.indexWhere((r) => r.id == reportId);
    if (i != -1) maintenanceReports[i] = updated;
    // لا نُحدِّث technicians[].available تفاؤليًا هنا (بعكس assignTechnicians)
    // — السيرفر قد يُبقي الفني "مشغولًا" فعليًا لو كان مُسنَدًا لأمر عمل آخر
    // مفتوح غير هذا، فتحديث متفائل هنا قد يعرض "متاح" خطأً؛ يُصحَّح تلقائيًا
    // مع أول تحديث دوري لقائمة الفنيين.
    _log('تم إزالة فني من "${updated.equipment}"');
    notifyListeners();
  }

  Future<void> closeReport(
    String reportId, {
    required String closeDescription,
    required String partsUsed,
    String? closeNotes,
  }) async {
    final data = await _api.patch('/work-orders/$reportId/close', {
      'closeDescription': closeDescription,
      'spareParts': partsUsed.trim().isEmpty ? [] : [{'partName': partsUsed.trim()}],
      if (closeNotes != null && closeNotes.trim().isNotEmpty) 'closeNotes': closeNotes.trim(),
    });
    final updated = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    // القطع المستخدمة لا تعود ضمن استجابة الإغلاق نفسها (تُحفظ في جدول
    // منفصل) — نعرضها فورًا من النص الذي أدخله المستخدم للتو بدل طلب إضافي؛
    // راجع [fetchWorkOrderDetail] للحصول عليها بدقة من السيرفر لاحقًا (بعد
    // إعادة تشغيل التطبيق مثلًا).
    updated.partsUsed = partsUsed.trim().isEmpty ? null : partsUsed.trim();

    final i = maintenanceReports.indexWhere((r) => r.id == reportId);
    if (i != -1) maintenanceReports[i] = updated;

    // السيرفر يُعيد كل الفنيين (وليس فنيًا واحدًا فقط) المُسنَد إليهم هذا
    // البلاغ إلى حالة "متاح" ضمن نفس عملية الإغلاق — نطلب قائمة الفنيين من
    // جديد بدل تحديث محلي متفائل جزئي قد لا يشمل كل فني عمل على البلاغ.
    unawaited(reloadTechnicians());

    _log('تم إنجاز بلاغ "${updated.equipment}" '
        '(المدة: ${updated.duration != null ? updated.duration!.inMinutes : 0} دقيقة)');
    notifyListeners();
  }

  /// تفاصيل كاملة لأمر عمل واحد (بما فيها القطع المستخدمة الفعلية من جدول
  /// spare_parts_used) — تُستخدم عند فتح تقرير PDF لعمل مُنجز، لضمان دقة
  /// القطع المعروضة حتى بعد إعادة تشغيل التطبيق (بخلاف الاعتماد على القيمة
  /// المحلية المؤقتة في [closeReport] أعلاه).
  Future<MaintenanceReport> fetchWorkOrderDetail(String id) async {
    final data = await _api.get('/work-orders/$id');
    final report = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    final parts = (data['spareParts'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    if (parts.isNotEmpty) {
      report.partsUsed = parts.map((p) => '${p['part_name']}${(p['quantity'] ?? 1) != 1 ? ' × ${p['quantity']}' : ''}').join('، ');
    }
    return report;
  }

  /// طلب تقرير صيانة بمدة مخصّصة — يُنشئ السيرفر ملف تقرير HTML احترافي
  /// لكل بلاغات وأوامر عمل الصيانة خلال المدة المحددة، ويحاول إرسال رابطه
  /// مباشرة عبر واتساب لرقم طالب التقرير نفسه فقط (راجع routes/workOrders.js
  /// و services/maintenanceReport.js) — بنفس نمط [requestProductionReport] تمامًا.
  Future<ReportRequestResult> requestMaintenanceReport({
    required DateTime from,
    required DateTime to,
  }) async {
    final data = await _api.post('/work-orders/reports/request', {
      'from': from.toIso8601String(),
      'to': to.toIso8601String(),
    });
    return ReportRequestResult(
      reportUrl: data['reportUrl'] as String,
      whatsappSent: data['whatsappSent'] as bool? ?? false,
      warning: data['warning'] as String?,
    );
  }

  // ---------------------------------------------------------------------
  // المخزون والقطع — كتالوج أصناف [InventoryItem] وطلبات قطع [PartRequest]
  // (راجع routes/inventory.js وschema.sql للتفاصيل الكاملة). قسم فرعي جديد
  // داخل تبويب الصيانة، لكن حالته منفصلة تمامًا عن maintenanceReports أعلاه.
  // ---------------------------------------------------------------------
  final List<InventoryItem> inventoryItems = [];
  bool inventoryItemsLoaded = false;
  String? inventoryItemsError;

  final List<PartRequest> partRequests = [];
  bool partRequestsLoaded = false;
  String? partRequestsError;

  Future<void> reloadInventoryItems() => _loadInventoryItemsFromCloud();

  Future<void> _loadInventoryItemsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/inventory/items');
      final list = (data['items'] as List).cast<Map<String, dynamic>>();
      inventoryItems
        ..clear()
        ..addAll(list.map(InventoryItem.fromApi));
      inventoryItemsLoaded = true;
      inventoryItemsError = null;
      notifyListeners();
    } catch (e) {
      inventoryItemsError = 'تعذّر تحميل كتالوج المخزون من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> reloadPartRequests() => _loadPartRequestsFromCloud();

  Future<void> _loadPartRequestsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/inventory/part-requests');
      final list = (data['partRequests'] as List).cast<Map<String, dynamic>>();
      partRequests
        ..clear()
        ..addAll(list.map(PartRequest.fromApi));
      partRequestsLoaded = true;
      partRequestsError = null;
      notifyListeners();
    } catch (e) {
      partRequestsError = 'تعذّر تحميل طلبات القطع من السيرفر: $e';
      notifyListeners();
    }
  }

  /// فئات الأصناف المستخدمة سابقًا (بلا تكرار) — تُعرض كاقتراحات سريعة عند
  /// إضافة صنف جديد، بنفس فكرة [previousTaskLocations] تمامًا.
  List<String> get previousInventoryCategories {
    final set = <String>{};
    for (final i in inventoryItems) {
      final c = i.category?.trim();
      if (c != null && c.isNotEmpty) set.add(c);
    }
    final list = set.toList()..sort();
    return list;
  }

  Future<void> addInventoryItem({
    required String name,
    String? category,
    String unit = 'قطعة',
    int quantity = 0,
    int? minQuantity,
    String? notes,
    String? supplierId,
    String? siteId,
  }) async {
    final data = await _api.post('/inventory/items', {
      'name': name,
      'category': category,
      'unit': unit,
      'quantity': quantity,
      'minQuantity': minQuantity,
      'notes': notes,
      'supplierId': supplierId,
      'siteId': siteId,
    });
    inventoryItems.add(InventoryItem.fromApi(data['item'] as Map<String, dynamic>));
    _log('تمت إضافة صنف جديد للمخزون: $name');
    notifyListeners();
  }

  Future<void> updateInventoryItem(
    String id, {
    required String name,
    String? category,
    required String unit,
    required int quantity,
    int? minQuantity,
    String? notes,
    String? supplierId,
    String? siteId,
  }) async {
    final data = await _api.patch('/inventory/items/$id', {
      'name': name,
      'category': category,
      'unit': unit,
      'quantity': quantity,
      'minQuantity': minQuantity,
      'notes': notes,
      'supplierId': supplierId,
      'siteId': siteId,
    });
    final updated = InventoryItem.fromApi(data['item'] as Map<String, dynamic>);
    final i = inventoryItems.indexWhere((e) => e.id == id);
    if (i != -1) inventoryItems[i] = updated;
    notifyListeners();
  }

  Future<void> removeInventoryItem(String id) async {
    await _api.delete('/inventory/items/$id');
    inventoryItems.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  /// "حركة مخزون سريعة" — ودجت البحث عن صنف + توريد/صرف/تسوية جرد مباشرة
  /// بلا فتح نموذج تعديل الصنف الكامل. [type] واحد من: supply (توريد)،
  /// consumable_issue (صرف استهلاكي)، stock_reconciliation (تسوية جرد) —
  /// راجع POST /inventory/items/:id/movement في routes/inventory.js لشرح
  /// معنى [quantity] المختلف حسب النوع (كمية الحركة نفسها لتوريد/صرف، أو
  /// الرصيد الفعلي المعدود لتسوية الجرد).
  Future<InventoryItem> recordQuickMovement({
    required String itemId,
    required String type,
    required num quantity,
    String? notes,
  }) async {
    final data = await _api.post('/inventory/items/$itemId/movement', {
      'type': type,
      'quantity': quantity,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    });
    final updated = InventoryItem.fromApi(data['item'] as Map<String, dynamic>);
    final i = inventoryItems.indexWhere((e) => e.id == itemId);
    if (i != -1) inventoryItems[i] = updated;
    _log('تسجيل حركة مخزون سريعة على: ${updated.name}');
    notifyListeners();
    return updated;
  }

  /// يقدّم الفني (أو مسؤول الصيانة) طلب قطعة جديدًا — إما من صنف موجود
  /// بالكتالوج ([itemId]) أو باسم حر لقطعة غير مكتلَنة بعد تحتاج تصميمًا
  /// ([itemName] + [needsDesign]: true). لا يُخصم أي شيء من المخزون هنا —
  /// فقط عند تأكيد الصرف لاحقًا (راجع [issuePartRequest]).
  Future<void> createPartRequest({
    String? itemId,
    String? itemName,
    int quantity = 1,
    String? workOrderId,
    String? notes,
    bool needsDesign = false,
  }) async {
    final data = await _api.post('/inventory/part-requests', {
      if (itemId != null) 'itemId': itemId,
      if (itemName != null && itemName.trim().isNotEmpty) 'itemName': itemName.trim(),
      'quantity': quantity,
      if (workOrderId != null) 'workOrderId': workOrderId,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      'needsDesign': needsDesign,
    });
    final partRequest = PartRequest.fromApi(data['partRequest'] as Map<String, dynamic>);
    partRequests.insert(0, partRequest);
    _log('تم تقديم طلب قطعة جديد: ${partRequest.itemName}');
    notifyListeners();
  }

  Future<void> cancelPartRequest(String id) async {
    await _api.delete('/inventory/part-requests/$id');
    partRequests.removeWhere((p) => p.id == id);
    notifyListeners();
  }

  /// المصمم يرفع نتيجة التصميم (صورة/ملف كـ data URL + ملاحظات اختيارية) —
  /// ينقل الطلب لمرحلة "بانتظار الصرف".
  Future<void> submitPartDesign(
    String id, {
    required String designFileDataUrl,
    String? designNotes,
  }) async {
    final data = await _api.patch('/inventory/part-requests/$id/design', {
      'designFileDataUrl': designFileDataUrl,
      if (designNotes != null && designNotes.trim().isNotEmpty) 'designNotes': designNotes.trim(),
    });
    final updated = PartRequest.fromApi(data['partRequest'] as Map<String, dynamic>);
    final i = partRequests.indexWhere((p) => p.id == id);
    if (i != -1) partRequests[i] = updated;
    notifyListeners();
  }

  /// مسؤول المخزون (أو مسؤول الصيانة) يؤكد صرف القطعة فعليًا — هذه اللحظة
  /// الوحيدة التي يُخصم فيها العدد من رصيد الصنف بالكتالوج (لو كان مرتبطًا
  /// بصنف فعلي).
  Future<void> issuePartRequest(String id) async {
    final data = await _api.patch('/inventory/part-requests/$id/issue', {});
    final updated = PartRequest.fromApi(data['partRequest'] as Map<String, dynamic>);
    final i = partRequests.indexWhere((p) => p.id == id);
    if (i != -1) partRequests[i] = updated;
    // تحديث متفائل لرصيد الصنف محليًا بلا انتظار طلب تحميل جديد للكتالوج —
    // السيرفر نفسه هو مصدر الحقيقة الفعلي، وسيُصحَّح تلقائيًا عند الاستطلاع
    // الدوري التالي لو اختلف لأي سبب.
    if (updated.itemId != null) {
      final itemIdx = inventoryItems.indexWhere((e) => e.id == updated.itemId);
      if (itemIdx != -1) {
        final item = inventoryItems[itemIdx];
        inventoryItems[itemIdx] = InventoryItem(
          id: item.id,
          name: item.name,
          category: item.category,
          unit: item.unit,
          quantity: (item.quantity - updated.quantity).clamp(0, 1 << 31),
          minQuantity: item.minQuantity,
          notes: item.notes,
          supplierId: item.supplierId,
          supplierName: item.supplierName,
          siteId: item.siteId,
          siteName: item.siteName,
        );
      }
    }
    notifyListeners();
  }

  /// القطعة صُرفت لكن لم تُستخدم فعليًا — تعيد العدد لرصيد المخزون.
  Future<void> returnPartRequest(String id, {String? returnNotes}) async {
    final data = await _api.patch('/inventory/part-requests/$id/return', {
      if (returnNotes != null && returnNotes.trim().isNotEmpty) 'returnNotes': returnNotes.trim(),
    });
    final updated = PartRequest.fromApi(data['partRequest'] as Map<String, dynamic>);
    final i = partRequests.indexWhere((p) => p.id == id);
    if (i != -1) partRequests[i] = updated;
    if (updated.itemId != null) {
      final itemIdx = inventoryItems.indexWhere((e) => e.id == updated.itemId);
      if (itemIdx != -1) {
        final item = inventoryItems[itemIdx];
        inventoryItems[itemIdx] = InventoryItem(
          id: item.id,
          name: item.name,
          category: item.category,
          unit: item.unit,
          quantity: item.quantity + updated.quantity,
          minQuantity: item.minQuantity,
          notes: item.notes,
          supplierId: item.supplierId,
          supplierName: item.supplierName,
          siteId: item.siteId,
          siteName: item.siteName,
        );
      }
    }
    notifyListeners();
  }

  // ---------------------------------------------------------------------
  // سجل حركات المخزون [InventoryMovement] — للمراجعة والتدقيق فقط (سجل دائم
  // لا يُعدَّل من التطبيق). يُحمَّل عند فتح شاشته فقط (وليس ضمن attachAuth أو
  // الاستطلاع الدوري) لأنه سجل تاريخي طويل لا يحتاج تحديثًا لحظيًا كبيانات
  // العمل اليومية أعلاه. راجع routes/inventory.js (GET /movements).
  // ---------------------------------------------------------------------
  final List<InventoryMovement> inventoryMovements = [];
  bool inventoryMovementsLoaded = false;
  String? inventoryMovementsError;

  /// [itemId] فلترة اختيارية لعرض حركة صنف واحد فقط من داخل شاشته.
  Future<void> loadInventoryMovements({String? itemId}) async {
    if (!_attached) return;
    try {
      final data = await _api.get('/inventory/movements', query: itemId != null ? {'itemId': itemId} : null);
      final list = (data['movements'] as List).cast<Map<String, dynamic>>();
      inventoryMovements
        ..clear()
        ..addAll(list.map(InventoryMovement.fromApi));
      inventoryMovementsLoaded = true;
      inventoryMovementsError = null;
      notifyListeners();
    } catch (e) {
      inventoryMovementsError = 'تعذّر تحميل سجل حركة المخزون من السيرفر: $e';
      notifyListeners();
    }
  }

  // ---------------------------------------------------------------------
  // الموردون [Supplier] — سجل مستقل يُربط اختياريًا بأصناف الكتالوج. راجع
  // routes/inventory.js وschema.sql (جدول suppliers) للتفاصيل الكاملة.
  // ---------------------------------------------------------------------
  final List<Supplier> suppliers = [];
  bool suppliersLoaded = false;
  String? suppliersError;

  Future<void> reloadSuppliers() => _loadSuppliersFromCloud();

  Future<void> _loadSuppliersFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/inventory/suppliers');
      final list = (data['suppliers'] as List).cast<Map<String, dynamic>>();
      suppliers
        ..clear()
        ..addAll(list.map(Supplier.fromApi));
      suppliersLoaded = true;
      suppliersError = null;
      notifyListeners();
    } catch (e) {
      suppliersError = 'تعذّر تحميل قائمة الموردين من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> addSupplier({
    required String name,
    String? contactName,
    String? phone,
    String? email,
    String? address,
    String? notes,
  }) async {
    final data = await _api.post('/inventory/suppliers', {
      'name': name,
      'contactName': contactName,
      'phone': phone,
      'email': email,
      'address': address,
      'notes': notes,
    });
    suppliers.add(Supplier.fromApi(data['supplier'] as Map<String, dynamic>));
    _log('تمت إضافة مورّد جديد: $name');
    notifyListeners();
  }

  Future<void> updateSupplier(
    String id, {
    required String name,
    String? contactName,
    String? phone,
    String? email,
    String? address,
    bool active = true,
    String? notes,
  }) async {
    final data = await _api.patch('/inventory/suppliers/$id', {
      'name': name,
      'contactName': contactName,
      'phone': phone,
      'email': email,
      'address': address,
      'active': active,
      'notes': notes,
    });
    final updated = Supplier.fromApi(data['supplier'] as Map<String, dynamic>);
    final i = suppliers.indexWhere((e) => e.id == id);
    if (i != -1) suppliers[i] = updated;
    notifyListeners();
  }

  Future<void> removeSupplier(String id) async {
    await _api.delete('/inventory/suppliers/$id');
    suppliers.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  // ---------------------------------------------------------------------
  // مواقع العمل [WorkSite] — كيانات مُدارة يُربط بها اختياريًا أصناف
  // الكتالوج. راجع routes/inventory.js وschema.sql (جدول work_sites).
  // ---------------------------------------------------------------------
  final List<WorkSite> workSites = [];
  bool workSitesLoaded = false;
  String? workSitesError;

  Future<void> reloadWorkSites() => _loadWorkSitesFromCloud();

  Future<void> _loadWorkSitesFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/inventory/sites');
      final list = (data['sites'] as List).cast<Map<String, dynamic>>();
      workSites
        ..clear()
        ..addAll(list.map(WorkSite.fromApi));
      workSitesLoaded = true;
      workSitesError = null;
      notifyListeners();
    } catch (e) {
      workSitesError = 'تعذّر تحميل قائمة مواقع العمل من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> addWorkSite({required String name, String? notes}) async {
    final data = await _api.post('/inventory/sites', {'name': name, 'notes': notes});
    workSites.add(WorkSite.fromApi(data['site'] as Map<String, dynamic>));
    _log('تمت إضافة موقع عمل جديد: $name');
    notifyListeners();
  }

  Future<void> updateWorkSite(String id, {required String name, bool active = true, String? notes}) async {
    final data = await _api.patch('/inventory/sites/$id', {'name': name, 'active': active, 'notes': notes});
    final updated = WorkSite.fromApi(data['site'] as Map<String, dynamic>);
    final i = workSites.indexWhere((e) => e.id == id);
    if (i != -1) workSites[i] = updated;
    notifyListeners();
  }

  Future<void> removeWorkSite(String id) async {
    await _api.delete('/inventory/sites/$id');
    workSites.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  // ---------------------------------------------------------------------
  // "العهدة" — عدة ومعدات [CustodyItem] تُسلَّم لفني وتُرجَع لاحقًا، بعكس
  // القطع الاستهلاكية أعلاه. راجع routes/custody.js وschema.sql للتفاصيل
  // الكاملة. استجابة /custody/items تدمج بيانات آخر تسليم مفتوح مباشرة مع
  // كل عدة (current*) — لا حاجة لتحميل سجل تسليمات منفصل لعرض الشاشة
  // الرئيسية.
  // ---------------------------------------------------------------------
  final List<CustodyItem> custodyItems = [];
  bool custodyItemsLoaded = false;
  String? custodyItemsError;

  Future<void> reloadCustodyItems() => _loadCustodyItemsFromCloud();

  Future<void> _loadCustodyItemsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/custody/items');
      final list = (data['items'] as List).cast<Map<String, dynamic>>();
      custodyItems
        ..clear()
        ..addAll(list.map(CustodyItem.fromApi));
      custodyItemsLoaded = true;
      custodyItemsError = null;
      notifyListeners();
    } catch (e) {
      custodyItemsError = 'تعذّر تحميل كتالوج العهدة من السيرفر: $e';
      notifyListeners();
    }
  }

  /// فئات العهدة المستخدمة سابقًا (بلا تكرار) — بنفس فكرة
  /// [previousInventoryCategories] تمامًا.
  List<String> get previousCustodyCategories {
    final set = <String>{};
    for (final i in custodyItems) {
      final c = i.category?.trim();
      if (c != null && c.isNotEmpty) set.add(c);
    }
    final list = set.toList()..sort();
    return list;
  }

  Future<void> addCustodyItem({required String name, String? category, String? code, String? notes}) async {
    final data = await _api.post('/custody/items', {'name': name, 'category': category, 'code': code, 'notes': notes});
    custodyItems.add(CustodyItem.fromApi(data['item'] as Map<String, dynamic>));
    _log('تمت إضافة عدة جديدة للعهدة: $name');
    notifyListeners();
  }

  Future<void> updateCustodyItem(String id, {required String name, String? category, String? code, String? notes}) async {
    final data = await _api.patch('/custody/items/$id', {'name': name, 'category': category, 'code': code, 'notes': notes});
    final updated = CustodyItem.fromApi(data['item'] as Map<String, dynamic>);
    final i = custodyItems.indexWhere((e) => e.id == id);
    if (i != -1) custodyItems[i] = updated;
    notifyListeners();
  }

  Future<void> removeCustodyItem(String id) async {
    await _api.delete('/custody/items/$id');
    custodyItems.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  /// يسلّم عدة لفني — إما بمعرّف فني موجود ([technicianId]، يُشتق منه الاسم
  /// تلقائيًا) أو باسم حر ([assignedToName])، بنفس نمط itemId/itemName
  /// الاختياري في [createPartRequest]. يعيد تحميل الكتالوج بعدها مباشرة
  /// لأن الاستجابة الوحيدة القادمة هي سجل التسليم نفسه، وأبسط طريقة لعكس
  /// current* الجديدة على العدة هي إعادة الجلب بدل بناء الدمج يدويًا هنا.
  Future<void> assignCustodyItem({
    required String itemId,
    String? technicianId,
    String? assignedToName,
    String? workOrderId,
    DateTime? expectedReturnAt,
    String? notes,
  }) async {
    await _api.post('/custody/assignments', {
      'itemId': itemId,
      if (technicianId != null) 'technicianId': technicianId,
      if (assignedToName != null && assignedToName.trim().isNotEmpty) 'assignedToName': assignedToName.trim(),
      if (workOrderId != null) 'workOrderId': workOrderId,
      if (expectedReturnAt != null) 'expectedReturnAt': expectedReturnAt.toIso8601String(),
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
    });
    _log('تم تسليم عهدة');
    await _loadCustodyItemsFromCloud();
  }

  /// يسترجع عهدة عبر معرّف سجل التسليم المفتوح (راجع
  /// [CustodyItem.currentAssignmentId]).
  Future<void> returnCustodyItem(String assignmentId, {String? returnNotes}) async {
    await _api.patch('/custody/assignments/$assignmentId/return', {
      if (returnNotes != null && returnNotes.trim().isNotEmpty) 'returnNotes': returnNotes.trim(),
    });
    _log('تم استرجاع عهدة');
    await _loadCustodyItemsFromCloud();
  }

  // ---------------------------------------------------------------------
  // الإنتاج — خطوط الإنتاج والباتشات (مربوطان بالسيرفر المحلي فعليًا، بنفس
  // نمط الفنيين أعلاه).
  // ---------------------------------------------------------------------
  final List<ProductionLine> productionLines = [];

  bool productionLinesLoaded = false;
  String? productionLinesError;

  Future<void> reloadProductionLines() => _loadProductionLinesFromCloud();

  Future<void> _loadProductionLinesFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/production/lines');
      final list = (data['lines'] as List).cast<Map<String, dynamic>>();
      productionLines
        ..clear()
        ..addAll(list.map(ProductionLine.fromApi));
      productionLinesLoaded = true;
      productionLinesError = null;
      notifyListeners();
    } catch (e) {
      productionLinesError = 'تعذّر تحميل خطوط الإنتاج من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> addProductionLineCloud({required String name, String? location}) async {
    final data = await _api.post('/production/lines', {
      'name': name,
      if (location != null && location.isNotEmpty) 'location': location,
    });
    productionLines.add(ProductionLine.fromApi(data['line'] as Map<String, dynamic>));
    notifyListeners();
  }

  Future<void> updateProductionLineCloud(
    String id, {
    String? name,
    String? location,
    bool? active,
  }) async {
    final body = <String, dynamic>{};
    if (name != null) body['name'] = name;
    if (location != null) body['location'] = location;
    if (active != null) body['active'] = active;
    if (body.isEmpty) return;

    final data = await _api.patch('/production/lines/$id', body);
    final updated = ProductionLine.fromApi(data['line'] as Map<String, dynamic>);
    final i = productionLines.indexWhere((l) => l.id == id);
    if (i != -1) productionLines[i] = updated;
    notifyListeners();
  }

  Future<void> removeProductionLineCloud(String id) async {
    await _api.delete('/production/lines/$id');
    productionLines.removeWhere((l) => l.id == id);
    notifyListeners();
  }

  /// خطوط الإنتاج التابعة لقسم/مصنع معيّن (مثال: 'مصنع الرجال') — أساس فصل
  /// "مصنع الرجال" عن "مصنع النساء" إداريًا في الواجهة، حسب عمود location
  /// الموجود فعليًا على كل خط (ومقيَّد بنفس القيم على السيرفر، راجع
  /// kFacilityLocations في services/constants.dart).
  List<ProductionLine> linesByFacility(String facility) =>
      productionLines.where((l) => l.location == facility).toList();

  // ---------------------------------------------------------------------
  // معدات الإنتاج (equipment) — قائمة يديرها الإنتاج/الصيانة بأنفسهم
  // (إضافة/تعديل/حذف) من شاشة ProductionEquipmentScreen، وتُستخدم عند رفع
  // بلاغ عطل لإظهار اسم المعدة وكودها تلقائيًا في رسالة واتساب (بدل كتابتهما
  // يدويًا). نفس نمط خطوط الإنتاج أعلاه تمامًا.
  // ---------------------------------------------------------------------
  final List<Equipment> equipment = [];

  bool equipmentLoaded = false;
  String? equipmentError;

  Future<void> reloadEquipment() => _loadEquipmentFromCloud();

  Future<void> _loadEquipmentFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/production/equipment');
      final list = (data['equipment'] as List).cast<Map<String, dynamic>>();
      equipment
        ..clear()
        ..addAll(list.map(Equipment.fromApi));
      equipmentLoaded = true;
      equipmentError = null;
      notifyListeners();
    } catch (e) {
      equipmentError = 'تعذّر تحميل قائمة المعدات من السيرفر: $e';
      notifyListeners();
    }
  }

  // facility إلزامي هنا (وليس اختياريًا) لأن الشاشة الوحيدة التي تضيف معدات
  // (ProductionEquipmentScreen) تعرف قسمها دائمًا من widget.facility، وتمريره
  // هو ما يمنع ظهور معدة "بدون خط محدد" في قسم غير قسمها (راجع equipmentByFacility).
  Future<void> addEquipmentCloud({required String name, String? lineId, String? code, required String facility}) async {
    final data = await _api.post('/production/equipment', {
      'name': name,
      if (lineId != null) 'lineId': lineId,
      if (code != null && code.isNotEmpty) 'code': code,
      'facility': facility,
    });
    equipment.add(Equipment.fromApi(data['equipment'] as Map<String, dynamic>));
    notifyListeners();
  }

  // lineId/code/facility تُرسَل دائمًا (حتى لو null) بدل COALESCE — يطابق سلوك
  // PATCH /production/equipment/:id على السيرفر تمامًا (راجع التعليق هناك).
  // إرسال facility في كل تعديل يُصحّح تلقائيًا أي معدة قديمة أُضيفت قبل وجود
  // هذا الحقل بمجرد تعديلها وحفظها من داخل القسم الصحيح.
  Future<void> updateEquipmentCloud(String id, {String? name, String? lineId, String? code, String? facility}) async {
    final data = await _api.patch('/production/equipment/$id', {
      if (name != null) 'name': name,
      'lineId': lineId,
      'code': code,
      'facility': facility,
    });
    final updated = Equipment.fromApi(data['equipment'] as Map<String, dynamic>);
    final i = equipment.indexWhere((e) => e.id == id);
    if (i != -1) equipment[i] = updated;
    notifyListeners();
  }

  Future<void> removeEquipmentCloud(String id) async {
    await _api.delete('/production/equipment/$id');
    equipment.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  /// معدات خطوط قسم/مصنع معيّن + المعدات العامة (بدون خط محدد) الخاصة بنفس
  /// القسم فقط. معدة بلا خط تُنسب لقسمها عبر [Equipment.facility]؛ معدة قديمة
  /// (أُضيفت قبل وجود هذا الحقل) بلا facility مسجّل تبقى تظهر في كل الأقسام
  /// كسابق سلوكها — إلى أن تُحفظ من جديد من داخل قسمها الصحيح فيُثبَّت لها
  /// facility صحيح (راجع updateEquipmentCloud) فتختفي عندها من الأقسام الأخرى.
  List<Equipment> equipmentByFacility(String facility) {
    final lineIds = linesByFacility(facility).map((l) => l.id).toSet();
    return equipment.where((e) {
      if (e.lineId != null) return lineIds.contains(e.lineId);
      return e.facility == null || e.facility == facility;
    }).toList();
  }

  /// الباتشات — كانت محلية على جهاز المشرف فقط (تختفي عند إعادة تشغيل
  /// التطبيق)، أصبحت الآن محفوظة على السيرفر فعليًا (راجع routes/production.js
  /// و/production/batches) بنفس نمط خطوط الإنتاج والبلاغات أعلاه.
  final List<Batch> batches = [];
  bool batchesLoaded = false;
  String? batchesError;

  Future<void> reloadBatches() => _loadBatchesFromCloud();

  Future<void> _loadBatchesFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/production/batches');
      final list = (data['batches'] as List).cast<Map<String, dynamic>>();
      batches
        ..clear()
        ..addAll(list.map(Batch.fromApi));
      batchesLoaded = true;
      batchesError = null;
      notifyListeners();
    } catch (e) {
      batchesError = 'تعذّر تحميل الباتشات من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<Batch> recordBatchCloud({
    required String lineId,
    required String batchNumber,
    required String productName,
    required int quantity,
    bool hasStoppage = false,
    String? stoppageReason,
    int? stoppageMinutes,
    String? operationalNotes,
    String? actionsTaken,
    int? workersCount,
    String? timeFrom,
    String? timeTo,
    String? preventionMethods,
    DateTime? occurredAt,
  }) async {
    final data = await _api.post('/production/batches', {
      'lineId': lineId,
      'batchNumber': batchNumber,
      'productName': productName,
      'quantity': quantity,
      'hasStoppage': hasStoppage,
      if (stoppageReason != null) 'stoppageReason': stoppageReason,
      if (stoppageMinutes != null) 'stoppageMinutes': stoppageMinutes,
      if (operationalNotes != null) 'operationalNotes': operationalNotes,
      if (actionsTaken != null) 'actionsTaken': actionsTaken,
      if (workersCount != null) 'workersCount': workersCount,
      if (timeFrom != null) 'timeFrom': timeFrom,
      if (timeTo != null) 'timeTo': timeTo,
      if (preventionMethods != null) 'preventionMethods': preventionMethods,
      if (occurredAt != null) 'occurredAt': occurredAt.toIso8601String(),
    });
    final batch = Batch.fromApi(data['batch'] as Map<String, dynamic>);
    batches.insert(0, batch);
    _log('🔔 واتساب لجروب الإنتاج اليومي: باتش جديد على ${lineById(lineId).name} — الكمية $quantity');
    notifyListeners();
    return batch;
  }

  Future<void> removeBatchCloud(String id) async {
    await _api.delete('/production/batches/$id');
    batches.removeWhere((b) => b.id == id);
    notifyListeners();
  }

  /// تعديل باتش قديم — صلاحية "مسؤول إنتاج" أو مدير النظام فقط على السيرفر
  /// (راجع canManageBatches في auth_service.dart للتحقق في الواجهة قبل حتى
  /// إظهار زر التعديل). يُرسَل فقط الحقول التي فعلاً تغيّرت لتقليل حجم سجل
  /// التعديلات على السيرفر (production_batch_edits).
  Future<Batch> editBatchCloud(
    String id, {
    String? lineId,
    String? batchNumber,
    String? productName,
    int? quantity,
    bool? hasStoppage,
    String? stoppageReason,
    int? stoppageMinutes,
    String? operationalNotes,
    String? actionsTaken,
    int? workersCount,
    String? timeFrom,
    String? timeTo,
    String? preventionMethods,
    DateTime? occurredAt,
  }) async {
    final data = await _api.patch('/production/batches/$id', {
      if (lineId != null) 'lineId': lineId,
      if (batchNumber != null) 'batchNumber': batchNumber,
      if (productName != null) 'productName': productName,
      if (quantity != null) 'quantity': quantity,
      if (hasStoppage != null) 'hasStoppage': hasStoppage,
      if (stoppageReason != null) 'stoppageReason': stoppageReason,
      if (stoppageMinutes != null) 'stoppageMinutes': stoppageMinutes,
      if (operationalNotes != null) 'operationalNotes': operationalNotes,
      if (actionsTaken != null) 'actionsTaken': actionsTaken,
      if (workersCount != null) 'workersCount': workersCount,
      if (timeFrom != null) 'timeFrom': timeFrom,
      if (timeTo != null) 'timeTo': timeTo,
      if (preventionMethods != null) 'preventionMethods': preventionMethods,
      if (occurredAt != null) 'occurredAt': occurredAt.toIso8601String(),
    });
    final batch = Batch.fromApi(data['batch'] as Map<String, dynamic>);
    final index = batches.indexWhere((b) => b.id == id);
    if (index >= 0) {
      batches[index] = batch;
    } else {
      batches.insert(0, batch);
    }
    notifyListeners();
    return batch;
  }

  /// سجل تعديلات باتش معيّن (الأحدث أولًا) — يُحمَّل عند الطلب فقط (مثلاً عند
  /// فتح تفاصيل الباتش)، وليس ضمن التحميل العام كبقية القوائم.
  Future<List<BatchEdit>> loadBatchEdits(String batchId) async {
    final data = await _api.get('/production/batches/$batchId/edits');
    final list = (data['edits'] as List).cast<Map<String, dynamic>>();
    return list.map(BatchEdit.fromApi).toList();
  }

  /// طلب تقرير إنتاج بمدة مخصّصة — يُنشئ السيرفر ملف تقرير HTML لباتشات
  /// وبلاغات هذا المصنع خلال المدة المحددة، ويحاول إرسال رابطه مباشرة عبر
  /// واتساب (TextMeBot) لرقم طالب التقرير نفسه — راجع routes/production.js
  /// (POST /reports/request) و services/productionReport.js على السيرفر.
  /// نُعيد النتيجة كاملة (وليس الرابط فقط) لأن الإرسال عبر واتساب قد يفشل
  /// (مثلاً: مفتاح TextMeBot غير مضبوط بعد) بينما التقرير نفسه أُنشئ بنجاح —
  /// نريد عرض الرابط للمستخدم في كل الأحوال.
  Future<ReportRequestResult> requestProductionReport({
    required String facility,
    required DateTime from,
    required DateTime to,
  }) async {
    final data = await _api.post('/production/reports/request', {
      'facility': facility,
      'from': from.toIso8601String(),
      'to': to.toIso8601String(),
    });
    return ReportRequestResult(
      reportUrl: data['reportUrl'] as String,
      whatsappSent: data['whatsappSent'] as bool? ?? false,
      warning: data['warning'] as String?,
    );
  }

  ProductionLine lineById(String id) => productionLines.firstWhere((l) => l.id == id);

  bool _isToday(DateTime d) {
    final now = DateTime.now();
    return d.year == now.year && d.month == now.month && d.day == now.day;
  }

  /// كل الباتشات المسجّلة اليوم على خطوط قسم/مصنع معيّن — الباتشات صارت
  /// تُحفظ على السيرفر وتتراكم عبر الأيام، لذا لازم فلترة "اليوم" هنا صراحة
  /// (لم تكن لازمة سابقًا عندما كانت الباتشات محلية تُمسَح كل إعادة تشغيل).
  List<Batch> batchesByFacility(String facility) {
    final lineIds = linesByFacility(facility).map((l) => l.id).toSet();
    return batches.where((b) => lineIds.contains(b.lineId) && _isToday(b.date)).toList();
  }

  /// كل الباتشات (بلا قيد "اليوم") على خطوط قسم/مصنع معيّن ضمن مدة زمنية
  /// اختيارية — [b.date] هو occurred_at، فيظهر باتش سُجِّل اليوم بتاريخ أمس
  /// ضمن نطاق أمس لا اليوم. تُستخدم لعرض/تعديل الباتشات القديمة (خلافًا عن
  /// [batchesByFacility] المخصصة لعرض "اليوم" السريع فقط)، الأحدث تاريخًا أولًا.
  List<Batch> batchesInRange(String facility, {DateTime? from, DateTime? to}) {
    final lineIds = linesByFacility(facility).map((l) => l.id).toSet();
    final list = batches.where((b) {
      if (!lineIds.contains(b.lineId)) return false;
      if (from != null && b.date.isBefore(from)) return false;
      if (to != null && b.date.isAfter(to)) return false;
      return true;
    }).toList();
    list.sort((a, b) => b.date.compareTo(a.date));
    return list;
  }

  // ---------------------------------------------------------------------
  // الإنتاج — بلاغات أعطال فورية (مربوطة بالسيرفر المحلي فعليًا عبر
  // /production/incidents، بنفس نمط خطوط الإنتاج أعلاه).
  // ---------------------------------------------------------------------
  final List<Incident> incidents = [];
  bool incidentsLoaded = false;
  String? incidentsError;

  Future<void> reloadIncidents() => _loadIncidentsFromCloud();

  Future<void> _loadIncidentsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/production/incidents');
      final list = (data['incidents'] as List).cast<Map<String, dynamic>>();
      incidents
        ..clear()
        ..addAll(list.map(Incident.fromApi));
      incidentsLoaded = true;
      incidentsError = null;
      notifyListeners();
    } catch (e) {
      incidentsError = 'تعذّر تحميل البلاغات من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> addIncidentCloud({
    String? lineId,
    String? equipmentId,
    required String description,
    String? severity,
    String? photo,
  }) async {
    final data = await _api.post('/production/incidents', {
      if (lineId != null) 'lineId': lineId,
      if (equipmentId != null) 'equipmentId': equipmentId,
      'description': description,
      if (severity != null) 'severity': severity,
      if (photo != null) 'photo': photo,
    });
    incidents.insert(0, Incident.fromApi(data['incident'] as Map<String, dynamic>));
    _log('🔔 بلاغ عطل جديد في الإنتاج: $description');
    notifyListeners();
  }

  Future<void> endIncidentDowntimeCloud(String id) async {
    final data = await _api.patch('/production/incidents/$id/end-downtime', {});
    final updated = Incident.fromApi(data['incident'] as Map<String, dynamic>);
    final i = incidents.indexWhere((e) => e.id == id);
    if (i != -1) incidents[i] = updated;
    notifyListeners();
  }

  /// يحوّل بلاغ إنتاج مفتوح إلى أمر عمل صيانة حقيقي (طارئ، بانتظار تعيين
  /// فني) — يُستخدم من شاشة "بلاغات إنتاج بانتظار التحويل" في قسم الصيانة.
  /// السيرفر نفسه يربط أمر العمل بالبلاغ الأصلي (incidentReportId) ويحوّل
  /// حالة البلاغ تلقائيًا إلى "مرتبط" (راجع POST /work-orders)، فلا يظهر
  /// بعدها في قائمة البلاغات المفتوحة بانتظار التحويل.
  Future<MaintenanceReport> convertIncidentToWorkOrder(Incident incident) async {
    final data = await _api.post('/work-orders', {
      'kind': 'emergency',
      'incidentReportId': incident.id,
      if (incident.lineId != null) 'lineId': incident.lineId,
      if (incident.equipmentId != null) 'equipmentId': incident.equipmentId,
      'equipmentName': incident.equipmentName ?? (incident.lineName ?? 'غير محدد'),
      if (incident.facility != null) 'facility': incident.facility,
      'description': incident.description,
    });
    final report = MaintenanceReport.fromApi(data['workOrder'] as Map<String, dynamic>);
    maintenanceReports.insert(0, report);

    final i = incidents.indexWhere((e) => e.id == incident.id);
    if (i != -1) {
      // تحديث محلي متفائل لحالة البلاغ إلى "مرتبط" دون انتظار إعادة تحميل
      // كامل القائمة من السيرفر — يختفي فورًا من شاشة "بانتظار التحويل".
      incidents[i] = Incident(
        id: incident.id,
        lineId: incident.lineId,
        lineName: incident.lineName,
        facility: incident.facility,
        equipmentId: incident.equipmentId,
        equipmentName: incident.equipmentName,
        description: incident.description,
        reportedBy: incident.reportedBy,
        reportedAt: incident.reportedAt,
        downtimeStartedAt: incident.downtimeStartedAt,
        downtimeEndedAt: incident.downtimeEndedAt,
        status: 'linked',
        downtimeMinutes: incident.downtimeMinutes,
        severity: incident.severity,
      );
    }
    _log('تم تحويل بلاغ إنتاج إلى أمر عمل صيانة: ${incident.description}');
    notifyListeners();
    return report;
  }

  Future<void> removeIncidentCloud(String id) async {
    await _api.delete('/production/incidents/$id');
    incidents.removeWhere((e) => e.id == id);
    notifyListeners();
  }

  int lineTotalToday(String lineId) => batches
      .where((b) => b.lineId == lineId && _isToday(b.date))
      .fold(0, (sum, b) => sum + b.quantity);

  /// عدد باتشات اليوم فقط على خط معيّن — راجع ملاحظة فلترة "اليوم" أعلى
  /// [batchesByFacility].
  int batchCountTodayForLine(String lineId) =>
      batches.where((b) => b.lineId == lineId && _isToday(b.date)).length;

  // ---------------------------------------------------------------------
  // السلامة — تصاريح العمل (مربوطة بالسيرفر المحلي فعليًا عبر
  // /safety-permits، بنفس نمط الفنيين/الإنتاج/الصيانة أعلاه).
  // ---------------------------------------------------------------------
  final List<SafetyPermit> permits = [];
  bool permitsLoaded = false;
  String? permitsError;

  Future<void> reloadPermits() => _loadPermitsFromCloud();

  Future<void> _loadPermitsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/safety-permits');
      final list = (data['permits'] as List).cast<Map<String, dynamic>>();
      permits
        ..clear()
        ..addAll(list.map(SafetyPermit.fromApi));
      permitsLoaded = true;
      permitsError = null;
      notifyListeners();
    } catch (e) {
      permitsError = 'تعذّر تحميل تصاريح السلامة من السيرفر: $e';
      notifyListeners();
    }
  }

  /// طلب تصريح عمل جديد — equipmentPhotoBase64 بصيغة data URL كاملة
  /// (data:image/jpeg;base64,...) كما يتوقعها POST /safety-permits تمامًا؛
  /// اسم/دور مقدّم الطلب يُحدَّدان تلقائيًا على السيرفر من رمز الدخول، فلا
  /// حاجة لإرسالهما هنا.
  Future<SafetyPermit> requestPermitCloud({
    required String location,
    required String description,
    required int workersCount,
    required List<String> operationTypes,
    required String equipmentPhotoBase64,
    String? officeName,
    String? equipmentUsed,
    String? responsiblePhone,
    DateTime? startAt,
    DateTime? endAt,
    String? relatedWorkOrderId,
  }) async {
    final data = await _api.post('/safety-permits', {
      'location': location,
      'description': description,
      'workersCount': workersCount,
      'operationTypes': operationTypes,
      'equipmentPhoto': equipmentPhotoBase64,
      if (officeName != null && officeName.isNotEmpty) 'officeName': officeName,
      if (equipmentUsed != null && equipmentUsed.isNotEmpty) 'equipmentUsed': equipmentUsed,
      if (responsiblePhone != null && responsiblePhone.isNotEmpty) 'responsiblePhone': responsiblePhone,
      if (startAt != null) 'startAt': startAt.toIso8601String(),
      if (endAt != null) 'endAt': endAt.toIso8601String(),
      if (relatedWorkOrderId != null) 'relatedWorkOrderId': relatedWorkOrderId,
    });
    final permit = SafetyPermit.fromApi(data['permit'] as Map<String, dynamic>);
    permits.insert(0, permit);
    notifyListeners();
    return permit;
  }

  /// اعتماد أو رفض تصريح عمل — عند الموافقة (approve: true) يجب تمرير قوائم
  /// "خلو الموقع من التالي" و"المخاطر المحتملة" و"معدات الوقاية الشخصية"
  /// بالإضافة إلى الإجراءات الإلزامية (precautions)؛ وعند الرفض يجب تمرير
  /// سبب الرفض (rejectionReason) فقط — نفس حقول PATCH /safety-permits/:id/review
  /// الموجودة فعليًا على سيرفر صيانتي المحلي. اسم المراجِع يُحدَّد تلقائيًا
  /// على السيرفر من رمز الدخول.
  Future<void> reviewPermitCloud(
    String permitId, {
    required bool approve,
    List<String> siteHazards = const [],
    List<String> potentialRisks = const [],
    List<String> ppeRequired = const [],
    String? precautions,
    String? rejectionReason,
  }) async {
    final data = await _api.patch('/safety-permits/$permitId/review', {
      'approve': approve,
      if (approve) 'siteHazards': siteHazards,
      if (approve) 'potentialRisks': potentialRisks,
      if (approve) 'ppeRequired': ppeRequired,
      if (approve) 'precautions': precautions,
      if (!approve) 'rejectionReason': rejectionReason,
    });
    final updated = SafetyPermit.fromApi(data['permit'] as Map<String, dynamic>);
    final i = permits.indexWhere((p) => p.id == permitId);
    if (i != -1) permits[i] = updated;
    notifyListeners();
  }

  /// يحذف طلب تصريح نهائيًا من قاعدة البيانات (قسم السلامة أو مدير النظام
  /// فقط — راجع DELETE /safety-permits/:id).
  Future<void> removePermitCloud(String id) async {
    await _api.delete('/safety-permits/$id');
    permits.removeWhere((p) => p.id == id);
    notifyListeners();
  }

  /// طلب تقرير سلامة بمدة مخصّصة — يُنشئ السيرفر ملف تقرير HTML احترافي لكل
  /// طلبات تصاريح العمل خلال المدة المحددة (بتفاصيل كل طلب من التقديم وحتى
  /// القرار)، ويحاول إرسال رابطه مباشرة عبر واتساب لرقم طالب التقرير نفسه
  /// فقط (راجع routes/safetyPermits.js وservices/safetyReport.js) — بنفس
  /// نمط [requestMaintenanceReport] تمامًا.
  Future<ReportRequestResult> requestSafetyReport({
    required DateTime from,
    required DateTime to,
  }) async {
    final data = await _api.post('/safety-permits/reports/request', {
      'from': from.toIso8601String(),
      'to': to.toIso8601String(),
    });
    return ReportRequestResult(
      reportUrl: data['reportUrl'] as String,
      whatsappSent: data['whatsappSent'] as bool? ?? false,
      warning: data['warning'] as String?,
    );
  }

  // ---------------------------------------------------------------------
  // السلامة — تقارير تحقيق إصابات العمل (QMS-SAF-007)، مربوطة بالسيرفر
  // المحلي فعليًا عبر /injury-reports (راجع routes/injuryReports.js). القائمة
  // هنا مختصرة (بدون تفاصيل المصابين/الإجراءات) — التفاصيل الكاملة تُجلب عند
  // فتح تقرير معيّن (راجع fetchInjuryReportDetail) بنفس أسلوب أوامر العمل.
  // ---------------------------------------------------------------------
  final List<InjuryReport> injuryReports = [];
  bool injuryReportsLoaded = false;
  String? injuryReportsError;

  Future<void> reloadInjuryReports() => _loadInjuryReportsFromCloud();

  Future<void> _loadInjuryReportsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/injury-reports');
      final list = (data['reports'] as List).cast<Map<String, dynamic>>();
      injuryReports
        ..clear()
        ..addAll(list.map(InjuryReport.fromApi));
      injuryReportsLoaded = true;
      injuryReportsError = null;
      notifyListeners();
    } catch (e) {
      injuryReportsError = 'تعذّر تحميل تقارير إصابات العمل من السيرفر: $e';
      notifyListeners();
    }
  }

  /// يجلب تفاصيل تقرير إصابة كاملة (المصابون + الإجراءات + فريق التحقيق) —
  /// القائمة المحلية [injuryReports] لا تحمل هذه التفاصيل لتخفيف حجم الاستجابة.
  Future<InjuryReport> fetchInjuryReportDetail(String id) async {
    final data = await _api.get('/injury-reports/$id');
    return InjuryReport.fromApi(data['report'] as Map<String, dynamic>);
  }

  /// ينشئ تقرير تحقيق إصابة كامل (كل الخطوات الخمس دفعة واحدة).
  Future<InjuryReport> createInjuryReportCloud(InjuryReport draft) async {
    final data = await _api.post('/injury-reports', draft.toJson());
    final report = InjuryReport.fromApi(data['report'] as Map<String, dynamic>);
    injuryReports.insert(0, report);
    notifyListeners();
    return report;
  }

  /// يعدّل تقريرًا قائمًا (طالما لا يزال مفتوحًا) — يستبدل كل بيانات الخطوات
  /// الخمس دفعة واحدة، بنفس منطق الإنشاء.
  Future<InjuryReport> updateInjuryReportCloud(String id, InjuryReport draft) async {
    final data = await _api.patch('/injury-reports/$id', draft.toJson());
    final updated = InjuryReport.fromApi(data['report'] as Map<String, dynamic>);
    final i = injuryReports.indexWhere((r) => r.id == id);
    if (i != -1) injuryReports[i] = updated;
    notifyListeners();
    return updated;
  }

  /// يحدّث حالة إجراء تصحيحي واحد (تم / بانتظار) دون إعادة إرسال التقرير كاملًا.
  Future<void> setInjuryActionDone(String reportId, String actionId, bool done) async {
    await _api.patch('/injury-reports/$reportId/actions/$actionId', {'done': done});
  }

  /// الخطوة الخامسة: اعتماد التقرير وإغلاقه نهائيًا (يصبح للقراءة فقط، وجاهزًا
  /// للطباعة الرسمية).
  Future<InjuryReport> closeInjuryReportCloud(String id, {required String approvedBy, String? approvedByTitle}) async {
    final data = await _api.patch('/injury-reports/$id/close', {
      'approvedBy': approvedBy,
      if (approvedByTitle != null && approvedByTitle.isNotEmpty) 'approvedByTitle': approvedByTitle,
    });
    final updated = InjuryReport.fromApi(data['report'] as Map<String, dynamic>);
    final i = injuryReports.indexWhere((r) => r.id == id);
    if (i != -1) injuryReports[i] = updated;
    notifyListeners();
    return updated;
  }

  /// يعيد فتح تقرير مُغلَق للتعديل.
  Future<InjuryReport> reopenInjuryReportCloud(String id) async {
    final data = await _api.patch('/injury-reports/$id/reopen', {});
    final updated = InjuryReport.fromApi(data['report'] as Map<String, dynamic>);
    final i = injuryReports.indexWhere((r) => r.id == id);
    if (i != -1) injuryReports[i] = updated;
    notifyListeners();
    return updated;
  }

  /// يحذف تقرير تحقيق إصابة نهائيًا (قسم السلامة أو مدير النظام فقط).
  Future<void> removeInjuryReportCloud(String id) async {
    await _api.delete('/injury-reports/$id');
    injuryReports.removeWhere((r) => r.id == id);
    notifyListeners();
  }

  // ---------------------------------------------------------------------
  // إشعارات داخل التطبيق — مربوطة بالسيرفر فعليًا عبر /api/notifications
  // (راجع routes/notifications.js وservices/notifications.js). كل مستخدم
  // يرى إشعاراته الخاصة فقط. لا توجد إشعارات Push حقيقية بعد، لذا نستطلع
  // (Poll) هذه القائمة دوريًا (راجع [attachAuth] أعلاه) بدل الاعتماد على
  // دفعة فورية من السيرفر.
  // ---------------------------------------------------------------------
  final List<AppNotification> notifications = [];
  bool notificationsLoaded = false;
  String? notificationsError;

  int get unreadNotificationsCount => notifications.where((n) => !n.isRead).length;

  Future<void> reloadNotifications() => _loadNotificationsFromCloud();

  Future<void> _loadNotificationsFromCloud() async {
    if (!_attached) return;
    try {
      final data = await _api.get('/notifications');
      final list = (data['notifications'] as List).cast<Map<String, dynamic>>();
      notifications
        ..clear()
        ..addAll(list.map(AppNotification.fromApi));
      notificationsLoaded = true;
      notificationsError = null;
      notifyListeners();
    } catch (e) {
      // نُبقي القائمة كما كانت (لا نظهر خطأً مزعجًا لمجرد فشل استطلاع دوري
      // صامت) — الخطأ يظهر فقط لو طلب المستخدم تحديثًا يدويًا صريحًا.
      notificationsError = 'تعذّر تحميل الإشعارات من السيرفر: $e';
      notifyListeners();
    }
  }

  Future<void> markNotificationRead(String id) async {
    final i = notifications.indexWhere((n) => n.id == id);
    if (i == -1 || notifications[i].isRead) return;
    notifications[i].isRead = true; // تفاؤلي فورًا، قبل تأكيد السيرفر
    notifyListeners();
    try {
      await _api.patch('/notifications/$id/read');
    } catch (_) {
      // فشل التحديث على السيرفر لا يستحق إزعاج المستخدم — ستُصحَّح الحالة
      // تلقائيًا عند الاستطلاع الدوري التالي.
    }
  }

  Future<void> markAllNotificationsRead() async {
    if (unreadNotificationsCount == 0) return;
    for (final n in notifications) {
      n.isRead = true;
    }
    notifyListeners();
    try {
      await _api.patch('/notifications/read-all');
    } catch (_) {}
  }

  @override
  void dispose() {
    _notificationsTimer?.cancel();
    detachAuth();
    super.dispose();
  }
}
