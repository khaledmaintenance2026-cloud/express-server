import 'package:flutter/material.dart';

import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../admin/admin_home_screen.dart' show canOpenAdminTab;
import 'overtime_daily_tab.dart';
import 'overtime_employees_tab.dart';
import 'overtime_reports_tab.dart';
import 'overtime_widgets.dart';

/// من يرى تبويب "الإضافي"؟ مدير النظام ومسؤول الصيانة (نفس شرط تبويب الإدارة)
/// + مسؤول الإنتاج + مسؤول السلامة (قرار الإدارة 2026-10-06). الفني العادي
/// وموظف الإنتاج العادي والمخزون والمصمم والقسم العام لا يرونه. هذه الدالة
/// تُخفي التبويب في الواجهة فقط؛ القيد الملزم فعليًا على السيرفر في
/// routes/overtime.js (OVERTIME_ROLES) — يجب أن تبقى القائمتان متطابقتين.
bool canOpenOvertimeTab(AppRole role) =>
    canOpenAdminTab(role) || role == AppRole.productionManager || role == AppRole.safety;

/// شاشة "العمل الإضافي" — تبويب سفلي مخصّص للمسؤولين فقط (راجع
/// [canOpenOvertimeTab])؛ لا يظهر للفنيين ولا للأقسام العادية.
///
/// ثلاثة تبويبات داخلية: السجل اليومي (تسجيل الأعمال والأفراد المشاركين)،
/// التقارير (يوم/شهر: عرض وPDF وواتساب)، والأفراد (القائمة الدائمة).
class OvertimeHomeScreen extends StatelessWidget {
  const OvertimeHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 3,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('العمل الإضافي', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
          bottom: const TabBar(
            labelColor: kOvertimeColor,
            unselectedLabelColor: AppColors.textMuted,
            indicatorColor: kOvertimeColor,
            tabs: [
              Tab(text: 'السجل اليومي'),
              Tab(text: 'التقارير'),
              Tab(text: 'الأفراد'),
            ],
          ),
        ),
        body: const TabBarView(
          children: [
            OvertimeDailyTab(),
            OvertimeReportsTab(),
            OvertimeEmployeesTab(),
          ],
        ),
      ),
    );
  }
}
