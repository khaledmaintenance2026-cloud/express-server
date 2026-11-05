import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/safety_permit.dart';
import '../../services/app_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'injury_reports_list_screen.dart';
import 'safety_approval_screen.dart';
import 'safety_maintenance_report_screen.dart';
import 'safety_permit_print_screen.dart';
import 'safety_permit_request_screen.dart';
import 'safety_reports_screen.dart';

/// شاشة السلامة — تبويبان: تصاريح العمل، وإصابات العمل (QMS-SAF-007)، بنفس
/// أسلوب AdminHomeScreen (DefaultTabController + TabBar واحد أعلى الشاشة).
class SafetyHomeScreen extends StatelessWidget {
  const SafetyHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('السلامة', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
          actions: [
            IconButton(
              icon: const Icon(Icons.build_outlined),
              tooltip: 'رفع بلاغ صيانة',
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SafetyMaintenanceReportScreen()),
              ),
            ),
            IconButton(
              icon: const Icon(Icons.description_outlined),
              tooltip: 'التقارير',
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SafetyReportsScreen()),
              ),
            ),
          ],
          bottom: const TabBar(
            labelColor: AppColors.safetyText,
            unselectedLabelColor: AppColors.textMuted,
            indicatorColor: AppColors.safety,
            tabs: [
              Tab(text: 'تصاريح العمل'),
              Tab(text: 'إصابات العمل'),
            ],
          ),
        ),
        body: const TabBarView(
          children: [
            _SafetyPermitsTab(),
            InjuryReportsListScreen(),
          ],
        ),
      ),
    );
  }
}

class _SafetyPermitsTab extends StatefulWidget {
  const _SafetyPermitsTab();

  @override
  State<_SafetyPermitsTab> createState() => _SafetyPermitsTabState();
}

class _SafetyPermitsTabState extends State<_SafetyPermitsTab> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => context.read<AppState>().reloadPermits());
  }

  Future<void> _confirmDelete(SafetyPermit permit) async {
    final appState = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف طلب التصريح؟'),
        content: Text('سيُحذف طلب التصريح الخاص بـ "${permit.location}" نهائيًا ولا يمكن التراجع.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('حذف', style: TextStyle(color: Color(0xFFB3261E)))),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await appState.removePermitCloud(permit.id);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر حذف طلب التصريح: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();

    return Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Align(
                  alignment: Alignment.centerRight,
                  child: Text('تصاريح العمل', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: RefreshIndicator(
                    onRefresh: () => state.reloadPermits(),
                    child: !state.permitsLoaded && state.permitsError == null
                        ? const Center(child: CircularProgressIndicator())
                        : state.permitsError != null && state.permits.isEmpty
                            ? ListView(
                                children: [
                                  const SizedBox(height: 60),
                                  Center(
                                    child: Text(state.permitsError!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted)),
                                  ),
                                ],
                              )
                            : state.permits.isEmpty
                                ? ListView(
                                    children: const [
                                      SizedBox(height: 60),
                                      Center(child: Text('لا توجد تصاريح', style: TextStyle(color: AppColors.textMuted))),
                                    ],
                                  )
                                : ListView.separated(
                                    itemCount: state.permits.length,
                                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                                    itemBuilder: (context, i) {
                                      final permit = state.permits[i];
                                      return _PermitCard(permit: permit, onDelete: () => _confirmDelete(permit));
                                    },
                                  ),
                  ),
                ),
              ],
            ),
          ),
          Positioned(
            bottom: 20,
            left: 20,
            child: FloatingActionButton(
              backgroundColor: AppColors.safety,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(builder: (_) => const SafetyPermitRequestScreen()),
              ),
              child: const Icon(Icons.add, color: AppColors.safetyText),
            ),
          ),
        ],
    );
  }
}

class _PermitCard extends StatelessWidget {
  final SafetyPermit permit;
  final VoidCallback onDelete;
  const _PermitCard({required this.permit, required this.onDelete});

  @override
  Widget build(BuildContext context) {
    final statusInfo = switch (permit.status) {
      PermitStatus.pending => (label: 'بانتظار الموافقة', color: AppColors.warningText, bg: AppColors.warningBg),
      PermitStatus.approved => (label: 'تمت الموافقة', color: AppColors.successText, bg: AppColors.successBg),
      PermitStatus.rejected => (label: 'مرفوض', color: const Color(0xFFB3261E), bg: const Color(0x1FB3261E)),
    };

    return InkWell(
      borderRadius: BorderRadius.circular(16),
      // بانتظار الموافقة: يفتح شاشة المراجعة (قبول/رفض). مقبول أو مرفوض:
      // يفتح تقرير التصريح الكامل (من بداية الطلب وحتى القرار النهائي) —
      // كان لا يفعل شيئًا إطلاقًا سابقًا لأي تصريح تمت مراجعته بالفعل.
      onTap: permit.status == PermitStatus.pending
          ? () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => SafetyApprovalScreen(permit: permit)))
          : () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => SafetyPermitPrintScreen(permit: permit))),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Text(permit.location, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold))),
                if (permit.status != PermitStatus.pending)
                  const Padding(
                    padding: EdgeInsets.only(left: 6),
                    child: Icon(Icons.picture_as_pdf_outlined, size: 18, color: AppColors.textMuted),
                  ),
                StatusPill(label: statusInfo.label, color: statusInfo.color, background: statusInfo.bg),
                IconButton(
                  icon: const Icon(Icons.delete_outline, size: 20, color: AppColors.textMuted),
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  onPressed: onDelete,
                  tooltip: 'حذف',
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text(permit.description, style: const TextStyle(fontSize: 13, color: AppColors.textSecondary)),
            const SizedBox(height: 6),
            Text('مقدّم الطلب: ${permit.requesterName}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
            Text('نوع العمل: ${permit.operationTypesLabel}', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
            if (permit.relatedWorkOrderId != null)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('مرتبط ببلاغ صيانة قائم', style: TextStyle(fontSize: 11.5, color: AppColors.maintenance, fontWeight: FontWeight.w600)),
              ),
            if (permit.status == PermitStatus.rejected && permit.rejectionReason != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('سبب الرفض: ${permit.rejectionReason}', style: const TextStyle(fontSize: 11.5, color: Color(0xFFB3261E))),
              ),
          ],
        ),
      ),
    );
  }
}
