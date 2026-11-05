import 'package:flutter/material.dart';

/// ألوان الهوية البصرية لتطبيق "صيانتي" — مستخرجة من شعار العميل الفعلي.
class AppColors {
  AppColors._();

  // الألوان الأساسية لكل قسم
  static const Color maintenance = Color(0xFF2B3487); // كحلي
  static const Color production = Color(0xFF1F7A63); // أخضر مطفي
  static const Color safety = Color(0xFFFEBD10); // كهرماني/أصفر
  static const Color safetyText = Color(0xFF7A5100); // نص فوق خلفية السلامة الفاتحة
  // لون قسم "المخزون والقطع" المستقل (فُصل عن الصيانة لاحقًا) — بنفسجي مائل
  // للنيلي، متمايز بوضوح عن كحلي الصيانة وأخضر الإنتاج وأصفر السلامة.
  static const Color inventory = Color(0xFF6C4BA6);

  // محايدة
  static const Color background = Color(0xFFF5F6F8);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color border = Color(0xFFE3E6EB);
  static const Color textPrimary = Color(0xFF1A2129);
  static const Color textSecondary = Color(0xFF5C6673);
  static const Color textMuted = Color(0xFF8892A0);
  static const Color textFaint = Color(0xFFB4BAC2);
  static const Color divider = Color(0xFFEDEFF2);

  // حالات
  static const Color warningBg = Color(0x3DFEBD10); // 24% تقريبًا
  static const Color warningText = Color(0xFFB45309);
  static const Color successBg = Color(0x1F1F7A63);
  static const Color successText = Color(0xFF1F7A63);
}

class AppTheme {
  AppTheme._();

  static ThemeData light() {
    final base = ThemeData(
      useMaterial3: true,
      fontFamily: 'IBMPlexSansArabic',
      colorScheme: ColorScheme.fromSeed(
        seedColor: AppColors.maintenance,
        primary: AppColors.maintenance,
        surface: AppColors.surface,
      ),
      scaffoldBackgroundColor: AppColors.background,
    );

    return base.copyWith(
      textTheme: base.textTheme.apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: AppColors.background,
        foregroundColor: AppColors.textPrimary,
        elevation: 0,
        centerTitle: true,
      ),
      cardTheme: CardThemeData(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: AppColors.border),
        ),
      ),
      dividerTheme: const DividerThemeData(color: AppColors.divider),
    );
  }
}

/// لون القسم (صيانة / إنتاج / سلامة) لاستخدامه في الشارات والأزرار حسب السياق.
enum ModuleColor { maintenance, production, safety }

extension ModuleColorX on ModuleColor {
  Color get color {
    switch (this) {
      case ModuleColor.maintenance:
        return AppColors.maintenance;
      case ModuleColor.production:
        return AppColors.production;
      case ModuleColor.safety:
        return AppColors.safety;
    }
  }
}
