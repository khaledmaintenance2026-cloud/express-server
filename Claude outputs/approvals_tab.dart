import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/api_client.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// خيارات تقييد مستخدم قسم الإنتاج بمصنع واحد — null يعني بلا تقييد (يرى كل
/// المصانع)، وهو الافتراضي. راجع عمود production_facility على السيرفر.
const List<String?> kProductionFacilityChoices = [null, 'مصنع الرجال', 'مصنع النساء'];

String productionFacilityLabel(String? f) => f ?? 'بلا تقييد (كل المصانع)';

/// نفس القيم تمامًا لتقييد مسؤول قسم السلامة بقسم واحد (رجال أو نساء) —
/// عمود مستقل (safety_facility) عن الإنتاج أعلاه. null يعني بلا تقييد (يرى
/// تصاريح كل الأقسام)، وهو الافتراضي حتى يُخصَّص قسم صراحة.
const List<String?> kSafetyFacilityChoices = [null, 'مصنع الرجال', 'مصنع النساء'];

String safetyFacilityLabel(String? f) => f ?? 'بلا تقييد (كل الأقسام)';

/// مواقع موظف "قسم عام" (مستودع أو مكتب إداري محدد) — عمود مستقل
/// (general_facility) لا علاقة له بمصانع الإنتاج/السلامة أعلاه. null يعني لم
/// يُحدَّد بعد (يجب اختيار موقع فعلي قبل أن يستفيد الموظف من الشاشة عمليًا).
const List<String?> kGeneralFacilityChoices = [
  null,
  'مستودع الخام - نساء',
  'مستودع التام - نساء',
  'مستودع الزيوت',
  'مستودع الخام - رجال',
  'مستودع التام - رجال',
  'المكاتب الإدارية - نساء',
  'المكاتب الإدارية - رجال',
];

String generalFacilityLabel(String? f) => f ?? 'لم يُحدَّد بعد';

class ApprovalsTab extends StatefulWidget {
  const ApprovalsTab({super.key});

  @override
  State<ApprovalsTab> createState() => _ApprovalsTabState();
}

class _ApprovalsTabState extends State<ApprovalsTab> {
  final ApiClient _api = ApiClient.instance;
  bool _loading = true;
  String? _error;
  List<Map<String, dynamic>> _users = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await _api.get('/users');
      final users = (data['users'] as List).cast<Map<String, dynamic>>();
      users.sort((a, b) => (a['email'] as String? ?? '').compareTo(b['email'] as String? ?? ''));
      if (mounted) setState(() => _users = users);
    } catch (e) {
      if (mounted) setState(() => _error = 'تعذّر تحميل المستخدمين: $e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _approve(String uid, AppRole role, String? facility) async {
    await _api.patch('/users/$uid/approve', {'role': roleToString(role)});
    if (isProductionRole(role)) {
      await _api.patch('/users/$uid/production-facility', {'facility': facility});
    } else if (isSafetyRole(role)) {
      await _api.patch('/users/$uid/safety-facility', {'facility': facility});
    } else if (isGeneralRole(role)) {
      await _api.patch('/users/$uid/general-facility', {'facility': facility});
    }
    await _load();
  }

  Future<void> _reject(String uid) async {
    await _api.delete('/users/$uid');
    await _load();
  }

  Future<void> _setRole(String uid, AppRole role) async {
    await _api.patch('/users/$uid/role', {'role': roleToString(role)});
    await _load();
  }

  Future<void> _setFacility(String uid, String? facility) async {
    await _api.patch('/users/$uid/production-facility', {'facility': facility});
    await _load();
  }

  Future<void> _setSafetyFacility(String uid, String? facility) async {
    await _api.patch('/users/$uid/safety-facility', {'facility': facility});
    await _load();
  }

  Future<void> _setGeneralFacility(String uid, String? facility) async {
    await _api.patch('/users/$uid/general-facility', {'facility': facility});
    await _load();
  }

  Future<void> _setPhone(String uid, String? phone) async {
    await _api.patch('/users/$uid/phone', {'phone': phone});
    await _load();
  }

  Future<void> _revoke(String uid) async {
    await _api.patch('/users/$uid/revoke');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    final me = context.read<AuthService>().currentUser;
    final myUid = me?.uid;
    // مسؤول الصيانة يفتح هذه الشاشة أيضًا (قرار الإدارة 2026-10-04) لكنه لا
    // يمنح دور "مدير النظام" ولا يعدّل حسابات المدير — السيرفر يفرض ذلك فعليًا
    // (routes/users.js)، وهنا نُخفي الخيارات فقط كي لا تظهر أزرار سترفضها.
    final viewerIsAdmin = me?.role == AppRole.admin;
    final pending = _users.where((u) => u['status'] != 'approved').toList();
    final approved = _users.where((u) => u['status'] == 'approved').toList();

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 24),
        children: [
          if (_error != null) ...[
            InfoNote(text: _error!, color: const Color(0xFFB3261E), icon: Icons.error_outline),
            const SizedBox(height: 14),
          ],
          Text('طلبات بانتظار الاعتماد (${pending.length})',
              style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
          const SizedBox(height: 10),
          if (pending.isEmpty)
            const Text('لا توجد طلبات معلّقة', style: TextStyle(fontSize: 13, color: AppColors.textMuted))
          else
            ...pending.map((u) => _PendingCard(
                  user: u,
                  viewerIsAdmin: viewerIsAdmin,
                  onApprove: (role, facility) => _approve(u['id'].toString(), role, facility),
                  onReject: () => _reject(u['id'].toString()),
                )),
          const SizedBox(height: 24),
          Text('المستخدمون المعتمدون (${approved.length})',
              style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
          const SizedBox(height: 10),
          ...approved.map((u) => _ApprovedCard(
                user: u,
                viewerIsAdmin: viewerIsAdmin,
                isSelf: u['id'].toString() == myUid,
                onChangeRole: (role) => _setRole(u['id'].toString(), role),
                onChangeFacility: (facility) => _setFacility(u['id'].toString(), facility),
                onChangeSafetyFacility: (facility) => _setSafetyFacility(u['id'].toString(), facility),
                onChangeGeneralFacility: (facility) => _setGeneralFacility(u['id'].toString(), facility),
                onChangePhone: (phone) => _setPhone(u['id'].toString(), phone),
                onRevoke: () => _revoke(u['id'].toString()),
              )),
        ],
      ),
    );
  }
}

class _PendingCard extends StatefulWidget {
  final Map<String, dynamic> user;

  /// مدير النظام فقط يرى خيار "مدير النظام" في قائمة الصلاحيات.
  final bool viewerIsAdmin;
  final void Function(AppRole role, String? facility) onApprove;
  final VoidCallback onReject;

  const _PendingCard({required this.user, required this.viewerIsAdmin, required this.onApprove, required this.onReject});

  @override
  State<_PendingCard> createState() => _PendingCardState();
}

class _PendingCardState extends State<_PendingCard> {
  AppRole _role = AppRole.production;
  String? _facility;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.warningText.withOpacity(0.3)),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text((widget.user['name'] as String?) ?? '', style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
          Text((widget.user['email'] as String?) ?? '', style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          if ((widget.user['phone'] as String?)?.isNotEmpty ?? false)
            Text(widget.user['phone'] as String, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
          const SizedBox(height: 10),
          Row(
            children: [
              const Text('الصلاحية:', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Expanded(
                child: DropdownButtonFormField<AppRole>(
                  value: _role,
                  isDense: true,
                  decoration: const InputDecoration(
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    filled: true,
                    fillColor: AppColors.background,
                    border: OutlineInputBorder(),
                  ),
                  items: AppRole.values
                      .where((r) => widget.viewerIsAdmin || r != AppRole.admin)
                      .map((r) => DropdownMenuItem(value: r, child: Text(roleLabel(r), style: const TextStyle(fontSize: 12.5))))
                      .toList(),
                  onChanged: (v) => setState(() => _role = v ?? _role),
                ),
              ),
            ],
          ),
          if (isProductionRole(_role)) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                const Text('المصنع:', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String?>(
                    value: _facility,
                    isDense: true,
                    decoration: const InputDecoration(
                      contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      filled: true,
                      fillColor: AppColors.background,
                      border: OutlineInputBorder(),
                    ),
                    items: kProductionFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(productionFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: (v) => setState(() => _facility = v),
                  ),
                ),
              ],
            ),
          ] else if (isSafetyRole(_role)) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                const Text('قسم السلامة:', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String?>(
                    value: _facility,
                    isDense: true,
                    decoration: const InputDecoration(
                      contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      filled: true,
                      fillColor: AppColors.background,
                      border: OutlineInputBorder(),
                    ),
                    items: kSafetyFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(safetyFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: (v) => setState(() => _facility = v),
                  ),
                ),
              ],
            ),
          ] else if (isGeneralRole(_role)) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                const Text('الموقع:', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String?>(
                    value: _facility,
                    isDense: true,
                    decoration: const InputDecoration(
                      contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                      filled: true,
                      fillColor: AppColors.background,
                      border: OutlineInputBorder(),
                    ),
                    items: kGeneralFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(generalFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: (v) => setState(() => _facility = v),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: widget.onReject,
                  style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFFB3261E)),
                  child: const Text('رفض'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: ElevatedButton(
                  onPressed: () => widget.onApprove(
                    _role,
                    (isProductionRole(_role) || isSafetyRole(_role) || isGeneralRole(_role)) ? _facility : null,
                  ),
                  style: ElevatedButton.styleFrom(backgroundColor: AppColors.successText, foregroundColor: Colors.white),
                  child: const Text('اعتماد'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ApprovedCard extends StatelessWidget {
  final Map<String, dynamic> user;

  /// مدير النظام وحده يعدّل حسابات المدير ويمنح دوره — لغيره (مسؤول الصيانة)
  /// تظهر بطاقة حساب المدير للعرض فقط بلا أي أزرار.
  final bool viewerIsAdmin;
  final bool isSelf;
  final void Function(AppRole role) onChangeRole;
  final void Function(String? facility) onChangeFacility;
  final void Function(String? facility) onChangeSafetyFacility;
  final void Function(String? facility) onChangeGeneralFacility;
  final void Function(String? phone) onChangePhone;
  final VoidCallback onRevoke;

  const _ApprovedCard({
    required this.user,
    required this.viewerIsAdmin,
    required this.isSelf,
    required this.onChangeRole,
    required this.onChangeFacility,
    required this.onChangeSafetyFacility,
    required this.onChangeGeneralFacility,
    required this.onChangePhone,
    required this.onRevoke,
  });

  Future<void> _editPhone(BuildContext context) async {
    final ctrl = TextEditingController(text: (user['phone'] as String?) ?? '');
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('رقم الجوال', style: TextStyle(fontSize: 15)),
        content: TextField(
          controller: ctrl,
          keyboardType: TextInputType.phone,
          autofocus: true,
          decoration: const InputDecoration(hintText: '05xxxxxxxx', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('إلغاء')),
          ElevatedButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()), child: const Text('حفظ')),
        ],
      ),
    );
    if (result != null) onChangePhone(result.isEmpty ? null : result);
  }

  @override
  Widget build(BuildContext context) {
    final role = roleFromString(user['role'] as String?);
    final facility = user['production_facility'] as String?;
    final safetyFacility = user['safety_facility'] as String?;
    final generalFacility = user['general_facility'] as String?;
    final phone = user['phone'] as String?;
    final locked = !viewerIsAdmin && role == AppRole.admin;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(16)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text((user['name'] as String?) ?? '', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                    Text((user['email'] as String?) ?? '', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                    InkWell(
                      onTap: locked ? null : () => _editPhone(context),
                      child: Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(Icons.phone_outlined, size: 12.5, color: AppColors.textMuted),
                            const SizedBox(width: 3),
                            Text(
                              (phone?.isNotEmpty ?? false) ? phone! : 'إضافة رقم الجوال',
                              style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted, decoration: TextDecoration.underline),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              if (isSelf)
                const StatusPill(label: 'أنت', color: AppColors.maintenance, background: Color(0x1F2B3487))
              else if (locked)
                const StatusPill(label: 'مدير النظام', color: AppColors.textSecondary, background: AppColors.background)
              else ...[
                DropdownButton<AppRole>(
                  value: role,
                  underline: const SizedBox(),
                  items: AppRole.values
                      .where((r) => viewerIsAdmin || r != AppRole.admin)
                      .map((r) => DropdownMenuItem(value: r, child: Text(roleLabel(r), style: const TextStyle(fontSize: 12.5))))
                      .toList(),
                  onChanged: (v) => v == null ? null : onChangeRole(v),
                ),
                IconButton(
                  tooltip: 'إلغاء الاعتماد',
                  icon: const Icon(Icons.block, size: 20, color: Color(0xFFB3261E)),
                  onPressed: onRevoke,
                ),
              ],
            ],
          ),
          if (!isSelf && isProductionRole(role)) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('المصنع:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButton<String?>(
                    value: kProductionFacilityChoices.contains(facility) ? facility : null,
                    isExpanded: true,
                    underline: const SizedBox(),
                    items: kProductionFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(productionFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: onChangeFacility,
                  ),
                ),
              ],
            ),
          ],
          if (!isSelf && isSafetyRole(role)) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('قسم السلامة:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButton<String?>(
                    value: kSafetyFacilityChoices.contains(safetyFacility) ? safetyFacility : null,
                    isExpanded: true,
                    underline: const SizedBox(),
                    items: kSafetyFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(safetyFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: onChangeSafetyFacility,
                  ),
                ),
              ],
            ),
          ],
          if (!isSelf && isGeneralRole(role)) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                const Text('الموقع:', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButton<String?>(
                    value: kGeneralFacilityChoices.contains(generalFacility) ? generalFacility : null,
                    isExpanded: true,
                    underline: const SizedBox(),
                    items: kGeneralFacilityChoices
                        .map((f) => DropdownMenuItem(value: f, child: Text(generalFacilityLabel(f), style: const TextStyle(fontSize: 12.5))))
                        .toList(),
                    onChanged: onChangeGeneralFacility,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
