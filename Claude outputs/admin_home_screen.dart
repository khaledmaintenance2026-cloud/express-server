import 'package:flutter/material.dart';

import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import 'approvals_tab.dart';
import 'technicians_tab.dart';

/// من يرى تبويب "الإدارة"؟ مدير النظام ومسؤول الصيانة فقط (قرار الإدارة
/// 2026-10-04) — الفني العادي وبقية الأدوار لا. هذه الدالة تُخفي التبويب في
/// الواجهة فقط؛ القيد الملزم فعليًا على السيرفر في routes/users.js
/// وroutes/technicians.js.
bool canOpenAdminTab(AppRole role) => role == AppRole.admin || role == AppRole.maintenanceManager;

/// شاشة الإدارة — لمدير النظام ومسؤول الصيانة. تبويبان: الفنيون (إضافة وتعديل
/// وحذف)، واعتماد المستخدمين (اعتماد، تغيير الصلاحية، الجوال، إلغاء الاعتماد،
/// الحذف). مسؤول الصيانة لا يمنح دور "مدير النظام" ولا يعدّل حسابات المدير.
class AdminHomeScreen extends StatelessWidget {
  const AdminHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('الإدارة', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
          bottom: const TabBar(
            labelColor: AppColors.maintenance,
            unselectedLabelColor: AppColors.textMuted,
            indicatorColor: AppColors.maintenance,
            tabs: [
              Tab(text: 'الفنيون'),
              Tab(text: 'اعتماد المستخدمين'),
            ],
          ),
        ),
        body: const TabBarView(
          children: [
            TechniciansTab(),
            ApprovalsTab(),
          ],
        ),
      ),
    );
  }
}
