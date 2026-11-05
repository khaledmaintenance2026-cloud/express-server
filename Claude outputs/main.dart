import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';

import 'firebase_options.dart';
import 'services/app_state.dart';
import 'services/auth_service.dart';
import 'services/biometric_service.dart';
import 'services/push_notification_service.dart';
import 'theme/app_theme.dart';
import 'screens/auth/login_screen.dart';
import 'screens/auth/complete_phone_screen.dart';
import 'screens/auth/pending_approval_screen.dart';
import 'screens/auth/welcome_screen.dart';
import 'screens/home/home_screen.dart';
import 'screens/maintenance/inventory_dashboard_screen.dart';
import 'screens/maintenance/maintenance_dashboard_screen.dart';
import 'screens/production/production_lines_screen.dart';
import 'screens/safety/safety_home_screen.dart';
import 'screens/admin/admin_home_screen.dart';
import 'screens/general/general_report_screen.dart';
Future<void> main() async {
  print('DIAG_TEST_9182');
  WidgetsFlutterBinding.ensureInitialized();
    try {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
  } catch (e) {
    print('Firebase init error: $e');
  }
  // لا ننتظر (await) تفعيل الإشعارات هنا — يعمل في الخلفية بعد فتح التطبيق
  // مباشرة، حتى لا تتأخر الشاشة الأولى بسبب بطء الاتصال بخدمات Google.
  // ignore: unawaited_futures
  PushNotificationService.initialize().catchError((e) {
    print('Push init error: $e');
  });
  runApp(const SayanatiApp());
}

class SayanatiApp extends StatelessWidget {
  const SayanatiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthService()),
        ChangeNotifierProvider(create: (_) => AppState()),
      ],
      child: MaterialApp(
        title: 'صيانتي',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        // ملاحظة: لا نضبط locale/localizationsDelegates هنا عمدًا — لو حدّدنا
        // locale بدون حزمة flutter_localizations الرسمية، فلن يجد Flutter
        // ترجمة MaterialLocalizations للعربية وسيتوقف التطبيق فور بدء التشغيل.
        // كل نصوص الواجهة عندنا مكتوبة عربيًا يدويًا مباشرة، والاتجاه من
        // اليمين لليسار مضمون بالكامل عبر Directionality بالأسفل، فلا حاجة
        // لضبط locale إطلاقًا.
        builder: (context, child) {
          return Directionality(
            textDirection: TextDirection.rtl,
            child: child!,
          );
        },
        home: const AuthGate(),
      ),
    );
  }
}

/// يقرر أي شاشة تظهر حسب حالة تسجيل الدخول: دخول/تسجيل، بانتظار الاعتماد،
/// أو الواجهة الرئيسية — ويربط AppState بمزوّد رمز الدخول فور تسجيل الدخول
/// لتفعيل تحميل الفنيين من Firestore.
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});

  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> {
  bool _attached = false;

  /// هل ظهرت شاشة الترحيب المتحركة مرة واحدة بالفعل خلال هذه الجلسة (منذ
  /// آخر فتح للتطبيق)؟ تظهر فقط قبل شاشة الدخول، ولا تتكرر بعد ذلك (مثلاً
  /// بعد تسجيل الخروج والعودة لشاشة الدخول من جديد ضمن نفس الجلسة).
  bool _welcomeShown = false;

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    if (auth.status == AuthStatus.signedIn && !_attached) {
      _attached = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        context.read<AppState>().attachAuth();
      });
    } else if (auth.status != AuthStatus.signedIn && _attached) {
      _attached = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        context.read<AppState>().detachAuth();
      });
    }

    switch (auth.status) {
      case AuthStatus.loading:
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      case AuthStatus.signedOut:
        if (!_welcomeShown) {
          return WelcomeScreen(onContinue: () => setState(() => _welcomeShown = true));
        }
        return const LoginScreen();
      case AuthStatus.needsPhone:
        return const CompletePhoneScreen();
      case AuthStatus.pendingApproval:
        return const PendingApprovalScreen();
      case AuthStatus.signedIn:
        if (auth.currentUser?.role == AppRole.general) {
          return const _BiometricLockGate(child: GeneralReportScreen());
        }
        return const _BiometricLockGate(child: RootNav());
    }
  }
}

/// طبقة قفل إضافية فوق الواجهة الرئيسية، تظهر فقط لو فعّل المستخدم "الدخول
/// بالبصمة" من شاشة الحساب — راجع lib/services/biometric_service.dart. لا
/// علاقة لها بجلسة الدخول نفسها (AuthService)؛ هي مجرد قفل محلي إضافي فوق
/// جلسة موجودة بالفعل، يُطلَب مرة واحدة عند كل فتح جديد للتطبيق (لا يتكرر
/// أثناء التنقل العادي بين الشاشات ضمن نفس الجلسة لأن هذا الـ Widget لا
/// يُعاد بناؤه إلا عند تبدّل حالة AuthStatus نفسها).
class _BiometricLockGate extends StatefulWidget {
  final Widget child;
  const _BiometricLockGate({required this.child});

  @override
  State<_BiometricLockGate> createState() => _BiometricLockGateState();
}

class _BiometricLockGateState extends State<_BiometricLockGate> {
  bool _checking = true;
  bool _unlocked = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final enabled = await BiometricService.instance.isEnabled();
    if (!mounted) return;
    if (!enabled) {
      setState(() {
        _unlocked = true;
        _checking = false;
      });
      return;
    }
    setState(() => _checking = false);
    _tryUnlock();
  }

  Future<void> _tryUnlock() async {
    final ok = await BiometricService.instance.authenticate();
    if (!mounted) return;
    setState(() => _unlocked = ok);
  }

  @override
  Widget build(BuildContext context) {
    if (_checking) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_unlocked) return widget.child;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.fingerprint, size: 72, color: AppColors.maintenance),
                const SizedBox(height: 16),
                const Text('التطبيق مقفل بالبصمة', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                const Text('اضغط الزر لفتحه ببصمتك', style: TextStyle(color: AppColors.textSecondary)),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: _tryUnlock,
                  icon: const Icon(Icons.fingerprint),
                  label: const Text('فتح ببصمتك'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: AppColors.maintenance,
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 14),
                  ),
                ),
                const SizedBox(height: 12),
                TextButton(
                  onPressed: () => context.read<AuthService>().signOut(),
                  child: const Text('تسجيل الخروج بدل ذلك'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// الحاوية الرئيسية: شريط تنقل سفلي يُبنى حسب دور المستخدم — كل دور يرى
/// قسمه فقط + الرئيسية، والمدير يرى كل الأقسام + الإدارة.
class RootNav extends StatefulWidget {
  const RootNav({super.key});

  @override
  State<RootNav> createState() => _RootNavState();
}

class _RootNavState extends State<RootNav> {
  int _index = 0;

  void _goToModule(String key) {
    final tabs = _buildKeys(context);
    final target = tabs.indexOf(key);
    if (target != -1) setState(() => _index = target);
  }

  List<String> _buildKeys(BuildContext context) {
    final role = context.read<AuthService>().currentUser?.role ?? AppRole.production;
    final keys = <String>['home'];
    if (role == AppRole.admin || isMaintenanceRole(role)) keys.add('maintenance');
    // "المخزون" تبويب مستقل الآن (فُصل عن لوحة الصيانة — راجع
    // inventory_dashboard_screen.dart)، لكنه يبقى مقصورًا على فريق الصيانة
    // والمخزون فقط (فني/مسؤول صيانة، مسؤول المخزون، المصمم) بقرار من الإدارة
    // — لم يُفتح لبقية الأقسام رغم استقلاليته. راجع نفس التعليق في
    // home_screen.dart.
    if (role == AppRole.admin || isMaintenanceRole(role) || isInventoryOnlyRole(role)) keys.add('inventory');
    if (role == AppRole.admin || isProductionRole(role)) keys.add('production');
    if (role == AppRole.admin || role == AppRole.safety) keys.add('safety');
    if (role == AppRole.admin) keys.add('admin');
    return keys;
  }

  @override
  Widget build(BuildContext context) {
    final role = context.watch<AuthService>().currentUser?.role ?? AppRole.production;
    final keys = _buildKeys(context);

    final screens = <String, Widget>{
      'home': HomeScreen(role: role, onSelectModule: _goToModule),
      'maintenance': const MaintenanceDashboardScreen(),
      'inventory': const InventoryDashboardScreen(),
      'production': const ProductionLinesScreen(),
      'safety': const SafetyHomeScreen(),
      'admin': const AdminHomeScreen(),
    };
    final items = <String, BottomNavigationBarItem>{
      'home': const BottomNavigationBarItem(icon: Icon(Icons.home_outlined), label: 'الرئيسية'),
      'maintenance': const BottomNavigationBarItem(icon: Icon(Icons.build_outlined), label: 'الصيانة'),
      'inventory': const BottomNavigationBarItem(icon: Icon(Icons.inventory_2_outlined), label: 'المخزون'),
      'production': const BottomNavigationBarItem(icon: Icon(Icons.factory_outlined), label: 'الإنتاج'),
      'safety': const BottomNavigationBarItem(icon: Icon(Icons.shield_outlined), label: 'السلامة'),
      'admin': const BottomNavigationBarItem(icon: Icon(Icons.admin_panel_settings_outlined), label: 'الإدارة'),
    };

    final index = _index.clamp(0, keys.length - 1);

    return Scaffold(
      body: IndexedStack(index: index, children: keys.map((k) => screens[k]!).toList()),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: index,
        onTap: (i) => setState(() => _index = i),
        type: BottomNavigationBarType.fixed,
        selectedItemColor: AppColors.maintenance,
        unselectedItemColor: AppColors.textFaint,
        showUnselectedLabels: true,
        items: keys.map((k) => items[k]!).toList(),
      ),
    );
  }
}
