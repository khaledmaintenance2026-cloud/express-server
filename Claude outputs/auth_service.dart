import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'api_client.dart';
import 'push_notification_service.dart';

/// أدوار المستخدمين داخل التطبيق. كل دور يرى قسمه فقط + الرئيسية،
/// عدا "مدير النظام" الذي يرى كل الأقسام + لوحة الإدارة.
///
/// نفس القيم بالضبط المستخدمة في عمود role بجدول users على سيرفر صيانتي
/// المحلي (راجع schema.sql) — لا حاجة لأي تحويل بين الطرفين.
///
/// دور "الصيانة" العام انقسم إلى دورين محددين بناءً على طلب الإدارة: فني
/// صيانة (ينفّذ الإصلاحات) ومسؤول صيانة (يوزّع البلاغات ويدير الفنيين).
/// كلاهما يريان قسم الصيانة نفسه بنفس الصلاحيات حاليًا — الفرق فقط في
/// المسمّى الظاهر عند الاعتماد وفي بطاقة المستخدم؛ استخدم [isMaintenanceRole]
/// بدل مقارنة الدور مباشرة عند التحقق من "هل هذا مستخدم صيانة؟" بغض النظر
/// عن أيهما تحديدًا.
///
/// "مسؤول إنتاج" (productionManager) دور مختلف عن ذلك: لا يرى شيئًا إضافيًا
/// في قسم الإنتاج، لكنه الوحيد (مع مدير النظام) القادر على تعديل أو حذف
/// باتش بعد تسجيله — راجع [canManageBatches] بدل مقارنة الدور مباشرة.
///
/// "مسؤول المخزون" (inventoryManager) و"مصمم" (designer): دوران جديدان لقسم
/// "المخزون والقطع" الجديد داخل تبويب الصيانة (راجع inventory_screen.dart
/// وInventoryItem/PartRequest في models/inventory.dart) — لا يريان بقية
/// تبويبات الصيانة (الأعطال الطارئة/الأعمال الوقائية) إطلاقًا، فقط تبويب
/// المخزون — راجع [canManageInventory]/[isDesigner] بدل مقارنة الدور مباشرة.
enum AppRole { admin, maintenanceTechnician, maintenanceManager, production, productionManager, safety, general, inventoryManager, designer }
bool isMaintenanceRole(AppRole r) => r == AppRole.maintenanceTechnician || r == AppRole.maintenanceManager;

/// هل يملك هذا الدور صلاحية إدارة كتالوج المخزون (إضافة/تعديل/حذف أصناف)
/// وتأكيد صرف/إرجاع طلبات القطع؟ (مدير النظام، مسؤول الصيانة، أو مسؤول
/// المخزون تحديدًا — قرار صريح من الإدارة، وليس الفني أو المصمم). راجع نفس
/// القيد الملزم فعليًا على السيرفر: INVENTORY_MANAGE_ROLES في
/// middleware/auth.js — هذه الدالة تُخفي أزرار الإدارة في الواجهة فقط.
bool canManageInventory(AppRole r) => r == AppRole.admin || r == AppRole.maintenanceManager || r == AppRole.inventoryManager;

/// هل هذا مستخدم "مصمم"؟ يرى تحديدًا طلبات القطع بحالة "بانتظار تصميم" ويرفع
/// نتيجة التصميم لها — راجع PartRequestStatus.pendingDesign.
bool isDesigner(AppRole r) => r == AppRole.designer;

/// هل يرى هذا الدور تبويب "المخزون" فقط داخل قسم الصيانة (بلا الأعطال
/// الطارئة/الأعمال الوقائية إطلاقًا)؟ مسؤول المخزون والمصمم كلاهما هنا فقط
/// لعمل واحد محدد ولا علاقة لهما بتوزيع/تنفيذ بلاغات الأعطال.
bool isInventoryOnlyRole(AppRole r) => r == AppRole.inventoryManager || r == AppRole.designer;

/// هل يملك هذا الدور صلاحية إنشاء "بلاغ وقائي جديد"، طلب "تقرير صيانة بمدة
/// مخصّصة"، أو حذف أمر عمل منجز نهائيًا؟ (مدير النظام أو مسؤول الصيانة فقط —
/// لا الفني — قرار صريح من الإدارة). راجع نفس القيد على السيرفر تحديدًا في
/// routes/workOrders.js: التحقق من kind === 'preventive' داخل POST /،
/// وrequireRole('maintenance_manager') على كل من DELETE /:id وPOST
/// /reports/request — هذه الدالة تُخفي الأزرار المقابلة في الواجهة فقط
/// (تجربة استخدام أنظف)، والتحقق الفعلي/الملزم يبقى دائمًا على السيرفر.
bool canManageMaintenance(AppRole r) => r == AppRole.admin || r == AppRole.maintenanceManager;

/// هل هذا مستخدم إنتاج (عادي أو مسؤول)؟ استخدمها بدل مقارنة
/// `role == AppRole.production` مباشرة في أي مكان يتعلق بقسم الإنتاج عمومًا
/// (رؤية القسم، تقييد المصنع) — لا في التحقق من صلاحية تعديل/حذف الباتش
/// تحديدًا (استخدم [canManageBatches] لتلك الحالة).
bool isProductionRole(AppRole r) => r == AppRole.production || r == AppRole.productionManager;

/// هل يملك هذا الدور صلاحية تعديل/حذف باتش إنتاج قديم؟ (مدير النظام أو
/// مسؤول إنتاج فقط — راجع PATCH/DELETE /api/production/batches/:id).
bool canManageBatches(AppRole r) => r == AppRole.admin || r == AppRole.productionManager;

/// هل هذا مستخدم سلامة؟ دالة صغيرة للتناسق مع [isProductionRole] أعلاه رغم
/// وجود قيمة واحدة فقط للدور حاليًا — تُستخدم عند إظهار حقل "قسم السلامة"
/// (تقييد بمصنع الرجال أو النساء) في لوحة اعتماد المستخدمين.
bool isSafetyRole(AppRole r) => r == AppRole.safety;

/// هل هذا مستخدم "قسم عام" (موظف مستودع أو مكتب إداري لا علاقة له بالإنتاج
/// أو الصيانة أو السلامة مباشرة)؟ صلاحيته الوحيدة رفع بلاغ عطل للصيانة —
/// راجع GeneralReportScreen وعمود general_facility في جدول users.
bool isGeneralRole(AppRole r) => r == AppRole.general;

AppRole roleFromString(String? s) {
  switch (s) {
    case 'admin':
      return AppRole.admin;
    case 'maintenance_technician':
      return AppRole.maintenanceTechnician;
    // "maintenance" هو الاسم القديم قبل تقسيم الدور — أي حساب لا يزال بهذا
    // الاسم على السيرفر (لم يُرحَّل بعد لأي سبب) يُعامَل كمسؤول صيانة، لأنه
    // كان يملك الصلاحيات الكاملة نفسها قبل التقسيم.
    case 'maintenance_manager':
    case 'maintenance':
      return AppRole.maintenanceManager;
    case 'production':
      return AppRole.production;
    case 'production_manager':
      return AppRole.productionManager;
    case 'safety':
      return AppRole.safety;
    case 'general':
      return AppRole.general;
    case 'inventory_manager':
      return AppRole.inventoryManager;
    case 'designer':
      return AppRole.designer;
    default:
      return AppRole.production;
  }
}

String roleToString(AppRole r) {
  switch (r) {
    case AppRole.maintenanceTechnician:
      return 'maintenance_technician';
    case AppRole.maintenanceManager:
      return 'maintenance_manager';
    case AppRole.productionManager:
      return 'production_manager';
    case AppRole.inventoryManager:
      return 'inventory_manager';
    default:
      return r.name;
  }
}

String roleLabel(AppRole r) {
  switch (r) {
    case AppRole.admin:
      return 'مدير النظام';
    case AppRole.maintenanceTechnician:
      return 'فني صيانة';
    case AppRole.maintenanceManager:
      return 'مسؤول صيانة';
    case AppRole.production:
      return 'الإنتاج';
    case AppRole.productionManager:
      return 'مسؤول إنتاج';
    case AppRole.safety:
      return 'السلامة';
    case AppRole.general:
      return 'قسم عام';
    case AppRole.inventoryManager:
      return 'مسؤول المخزون';
    case AppRole.designer:
      return 'مصمم';
  }
}

class AppUser {
  final String uid;
  final String email;
  final String name;
  final AppRole role;
  final bool approved;

  /// المصنع الذي يُقيَّد به مستخدم قسم الإنتاج (مصنع الرجال/مصنع النساء) —
  /// null يعني بلا تقييد (يرى كل المصانع)، وهذا حال كل الأدوار الأخرى دائمًا.
  /// يُحدَّد فقط من لوحة الإدارة (راجع PATCH /users/:id/production-facility).
  final String? productionFacility;

  /// قسم السلامة الذي يُقيَّد به مسؤول السلامة (مصنع الرجال/مصنع النساء) —
  /// عمود مستقل عن [productionFacility] أعلاه رغم القيم المشتركة. null يعني
  /// بلا تقييد (يرى تصاريح كل الأقسام)، وهذا الافتراضي حتى يُحدَّد له قسم
  /// صراحة من لوحة الإدارة (راجع PATCH /users/:id/safety-facility).
  final String? safetyFacility;

  /// الموقع المحدد لموظف "قسم عام" (مستودع أو مكتب إداري بعينه) — عمود مستقل
  /// (general_facility) عن الحقلين أعلاه. null يعني لم يُحدَّد بعد من الإدارة.
  final String? generalFacility;

  /// رقم الهاتف الشخصي للمستخدم — اختياري، يُدخله عند التسجيل أو يضيفه مدير
  /// النظام لاحقًا. يُستخدم لتوجيه إشعارات واتساب لهذا المستخدم تحديدًا (مثل
  /// نتيجة تصريح سلامة قدّمه) بدل جروب عام فقط.
  final String? phone;

  AppUser({
    required this.uid,
    required this.email,
    required this.name,
    required this.role,
    required this.approved,
    this.productionFacility,
    this.safetyFacility,
    this.generalFacility,
    this.phone,
  });

  /// يبني مستخدمًا من استجابة سيرفر صيانتي المحلي (حقل "user" في ردود
  /// /api/auth/* و /api/users) — الشكل: {id, name, email, role, status,
  /// production_facility, safety_facility, general_facility, phone}.
  factory AppUser.fromApi(Map<String, dynamic> d) => AppUser(
        uid: d['id'].toString(),
        email: (d['email'] as String?) ?? '',
        name: (d['name'] as String?) ?? '',
        role: roleFromString(d['role'] as String?),
        approved: d['status'] == 'approved',
        productionFacility: d['production_facility'] as String?,
        safetyFacility: d['safety_facility'] as String?,
        generalFacility: d['general_facility'] as String?,
        phone: d['phone'] as String?,
      );
}
/// needsPhone: حساب سُجّل دخوله بنجاح (عادةً عبر جوجل) لكنه بلا رقم جوال —
/// إلزامي الآن لكل حساب (راجع مسار التسجيل العادي) — يُطلب مباشرة قبل أي شيء
/// آخر، بما في ذلك قبل شاشة "بانتظار الاعتماد" لو كان الحساب جديدًا كليًا.
enum AuthStatus { loading, signedOut, needsPhone, pendingApproval, signedIn }

/// يحسم حالة الجلسة التالية بناءً على بيانات المستخدم نفسها: رقم الجوال أولًا
/// (إلزامي لإكمال أي شيء)، ثم حالة الاعتماد. دالة واحدة مشتركة بدل تكرار
/// المنطق نفسه في كل مكان (تسجيل الدخول، التسجيل، جوجل، استرجاع الجلسة).
AuthStatus _statusFor(AppUser user) {
  if (user.phone == null || user.phone!.trim().isEmpty) return AuthStatus.needsPhone;
  return user.approved ? AuthStatus.signedIn : AuthStatus.pendingApproval;
}

/// خدمة الدخول/الجلسة — تتحدث الآن مع سيرفر صيانتي المحلي (Node.js +
/// PostgreSQL) عبر [ApiClient] بدل Firebase Authentication + Cloud Firestore.
///
/// أُبقيت الواجهة العامة (status / currentUser / lastError / signIn / signUp
/// / signOut / validIdToken / refreshProfile) كما هي بالضبط عمدًا، حتى لا
/// تحتاج أي شاشة تستخدم AuthService لأي تعديل بعد هذا الاستبدال.
class AuthService extends ChangeNotifier {
  final ApiClient _api = ApiClient.instance;

  AppUser? currentUser;
  AuthStatus status = AuthStatus.loading;
  String? lastError;

  AuthService() {
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    final token = await _api.loadPersistedToken();
    if (token == null) {
      status = AuthStatus.signedOut;
      notifyListeners();
      return;
    }
    try {
      final data = await _api.get('/auth/me');
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      // إعادة محاولة تسجيل توكن الإشعار هنا تحديدًا: عند فتح التطبيق بجلسة
      // محفوظة سابقًا، هذه أول لحظة يصبح فيها رمز الدخول مؤكَّدًا وصالحًا —
      // لو حاول push_notification_service التسجيل قبل اكتمال هذا الاسترجاع
      // (سباق توقيت عند بدء التشغيل)، فشلت المحاولة الأولى بصمت (401) ولن
      // تُعاد أبدًا بدون هذا الاستدعاء.
      PushNotificationService.registerTokenNow();
    } catch (e) {
      // الرمز المحفوظ لم يعد صالحًا (انتهت صلاحيته، أو أُلغي اعتماد الحساب
      // وحُذف) — وليس بالضرورة خطأ شبكة عابر؛ في حالة تعذّر الاتصال نُبقي
      // المستخدم في وضع "غير مسجّل" ونعرض السبب بدل تسجيل خروج صامت مربك.
      await _api.clearToken();
      status = AuthStatus.signedOut;
      if (e is ApiException && e.isConnectionError) lastError = e.message;
    }
    notifyListeners();
  }

  /// أُبقي هذا الاسم والنوع (Future<String>) للتوافق مع أي كود قديم ينتظر
  /// رمز دخول Firebase-style؛ عمليًا رمز صيانتي المحلي (JWT) صالح لمدة ٣٠
  /// يومًا ولا يحتاج تجديدًا دوريًا كما كان الحال مع Firebase (كل ساعة).
  Future<String> get validIdToken async {
    if (!_api.hasToken) throw Exception('غير مسجّل الدخول');
    return 'session'; // القيمة نفسها غير مستخدَمة فعليًا الآن — ApiClient يرفق الرمز الحقيقي تلقائيًا بكل طلب.
  }

  Future<bool> signIn(String email, String password) async {
    lastError = null;
    try {
      final data = await _api.post('/auth/login', {
        'email': email.trim(),
        'password': password,
      });
      await _api.setToken(data['token'] as String);
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      notifyListeners();
      PushNotificationService.registerTokenNow();
      return true;
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
      return false;
    }
  }

  Future<bool> signUp(String name, String email, String password, {String? phone}) async {
    lastError = null;
    try {
      final data = await _api.post('/auth/register', {
        'name': name.trim(),
        'email': email.trim(),
        'password': password,
        if (phone != null && phone.trim().isNotEmpty) 'phone': phone.trim(),
      });
      await _api.setToken(data['token'] as String);
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      notifyListeners();
      PushNotificationService.registerTokenNow();
      return true;
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
      return false;
    }
  }

  String? _googleClientId;
  bool _googleConfigLoaded = false;

  /// يجلب معرّف عميل جوجل من السيرفر (site_settings) مرة واحدة فقط لكل جلسة
  /// تطبيق، ويخزّنه محليًا — لو تعذّر الوصول للسيرفر أو لم يُضبط المعرّف بعد
  /// يبقى null، ونتعامل مع ذلك كـ"تسجيل الدخول عبر جوجل غير مفعَّل" بدل خطأ.
  Future<String?> _fetchGoogleClientId() async {
    if (_googleConfigLoaded) return _googleClientId;
    try {
      final data = await _api.get('/auth/google-config');
      _googleClientId = data['clientId'] as String?;
    } catch (_) {
      _googleClientId = null;
    }
    _googleConfigLoaded = true;
    return _googleClientId;
  }

  /// تستخدمها شاشة الدخول لتقرير إظهار زر جوجل أو إخفاءه تمامًا — إخفاؤه
  /// أفضل من زر يفشل دائمًا لو لم يُضبط معرّف العميل على السيرفر بعد.
  Future<bool> googleSignInAvailable() async => (await _fetchGoogleClientId()) != null;

  /// يسجّل الدخول عبر جوجل (أو ينشئ حسابًا جديدًا بنفس دورة الاعتماد
  /// المعتادة لو كانت أول مرة) — يرجع true عند النجاح (حتى لو احتاج المستخدم
  /// بعدها إدخال رقم جواله، راجع [AuthStatus.needsPhone])، أو false مع تفصيل
  /// السبب في [lastError] عند الفشل، أو false بصمت لو أغلق المستخدم نافذة
  /// اختيار الحساب بنفسه (ليس خطأ يستدعي رسالة).
  Future<bool> signInWithGoogle() async {
    lastError = null;
    try {
      final clientId = await _fetchGoogleClientId();
      if (clientId == null) {
        lastError = 'تسجيل الدخول عبر جوجل غير مُفعَّل على السيرفر بعد';
        notifyListeners();
        return false;
      }

      // على الويب لا يوجد "تطبيق أندرويد" يتعرّف عليه جوجل عبر بصمة توقيع —
      // يجب تمرير معرّف العميل مباشرة عبر clientId (بدل serverClientId) حتى
      // تعرف مكتبة جوجل أي عميل ويب تستخدمه لعرض نافذة الدخول نفسها. على
      // أندرويد نُبقي على serverClientId كالمعتاد (فقط للتحقق من الـ aud في
      // رمز الدخول على السيرفر، دون أن يحتاج التطبيق أي معرّف عميل أندرويد).
      final googleSignIn = GoogleSignIn(
        scopes: const ['email'],
        clientId: kIsWeb ? clientId : null,
        serverClientId: kIsWeb ? null : clientId,
      );
      final account = await googleSignIn.signIn();
      if (account == null) return false; // المستخدم أغلق نافذة الاختيار بنفسه

      final googleAuth = await account.authentication;
      final idToken = googleAuth.idToken;
      if (idToken == null) {
        lastError = 'تعذّر الحصول على بيانات حساب جوجل، حاول مرة أخرى';
        notifyListeners();
        return false;
      }

      final data = await _api.post('/auth/google', {'idToken': idToken});
      await _api.setToken(data['token'] as String);
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      notifyListeners();
      PushNotificationService.registerTokenNow();
      return true;
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
      return false;
    } catch (e) {
      lastError = 'تعذّر تسجيل الدخول عبر جوجل، حاول مرة أخرى';
      notifyListeners();
      return false;
    }
  }

  /// يُستدعى من شاشة "استكمال البيانات" التي تظهر إلزاميًا حين تكون الحالة
  /// [AuthStatus.needsPhone] (حساب جوجل جديد بلا رقم جوال بعد).
  Future<bool> submitPhone(String phone) async {
    if (phone.trim().isEmpty) {
      lastError = 'رقم الجوال إلزامي';
      notifyListeners();
      return false;
    }
    lastError = null;
    try {
      final data = await _api.patch('/auth/phone', {'phone': phone.trim()});
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      notifyListeners();
      return true;
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
      return false;
    }
  }

  /// يُستدعى من شاشة "بانتظار الاعتماد" عند الضغط على زر التحديث، ومن
  /// لوحة الإدارة بعد أي تغيير على المستخدم الحالي نفسه.
  Future<void> refreshProfile() async {
    if (currentUser == null) return;
    try {
      final data = await _api.get('/auth/me');
      currentUser = AppUser.fromApi(data['user'] as Map<String, dynamic>);
      status = _statusFor(currentUser!);
      notifyListeners();
    } on ApiException catch (e) {
      // لو رفض السيرفر الرمز (401) فهذا يعني إلغاء الحساب أو حذفه من قِبل
      // المدير أثناء انتظار الاعتماد — نسجّل خروجًا فعليًا في هذه الحالة فقط.
      if (e.statusCode == 401) await signOut();
    }
  }

  /// يغيّر كلمة مرور المستخدم الحالي — يتطلب معرفة كلمة المرور الحالية.
  /// يُرجع true عند النجاح، أو false مع تفصيل السبب في [lastError].
  Future<bool> changePassword(String currentPassword, String newPassword) async {
    lastError = null;
    try {
      await _api.patch('/auth/change-password', {
        'currentPassword': currentPassword,
        'newPassword': newPassword,
      });
      return true;
    } on ApiException catch (e) {
      lastError = e.message;
      notifyListeners();
      return false;
    }
  }

  Future<void> signOut() async {
    await _api.clearToken();
    currentUser = null;
    lastError = null;
    status = AuthStatus.signedOut;
    notifyListeners();
  }
}
