import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

class MaintenanceNewReportScreen extends StatefulWidget {
  const MaintenanceNewReportScreen({super.key});

  @override
  State<MaintenanceNewReportScreen> createState() => _MaintenanceNewReportScreenState();
}

class _MaintenanceNewReportScreenState extends State<MaintenanceNewReportScreen> {
  String _line = kFacilityLocations.first;
  final _locationDetailCtrl = TextEditingController();
  final _equipmentCtrl = TextEditingController(text: 'ماكينة الخلط');
  final _descriptionCtrl = TextEditingController();
  bool _submitting = false;

  final _lines = kFacilityLocations;

  /// يجمع القسم المختار من القائمة مع تفاصيل موقع حرة اختيارية — يسمح لفريق
  /// الصيانة برفع بلاغ لأي مكان فعلي في المصنع (مثل "الإدارة" أو "بوابة
  /// الاستقبال" أو أي موقع لا يقع أصلًا ضمن الأقسام الثلاثة الرئيسية) بدل
  /// حصر البلاغ بأحد هذه الأقسام فقط كما كان سابقًا. بنفس نمط _fullLocation
  /// في safety_permit_request_screen.dart تمامًا (ونفس صيغة "$facility —
  /// $detail" المعروضة أصلًا في قائمة بلاغات الصيانة، راجع MaintenanceReport.line).
  String get _fullLocation =>
      _locationDetailCtrl.text.trim().isEmpty ? _line : '$_line — ${_locationDetailCtrl.text.trim()}';

  @override
  void dispose() {
    _locationDetailCtrl.dispose();
    _equipmentCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  /// وصف العطل إلزامي (نفس تحقق _submit أدناه بالضبط) — يُستخدم أيضًا لتعطيل
  /// زر الإرسال بصريًا قبل المحاولة، بنفس نمط باقي شاشات "بلاغ/إغلاق" في
  /// التطبيق (راجع general_report_screen.dart وmaintenance_task_close_screen.dart)
  /// بدل تركه مفعّلًا دائمًا وعرض رسالة خطأ بعد الضغط عليه فقط.
  bool get _canSubmit => !_submitting && _descriptionCtrl.text.trim().isNotEmpty;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() => _submitting = true);
    try {
      await context.read<AppState>().createReport(
            equipment: _equipmentCtrl.text.trim(),
            facility: _fullLocation,
            description: _descriptionCtrl.text.trim(),
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إرسال البلاغ لقسم الصيانة')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر إرسال البلاغ: $e')),
      );
    }
  }

  String _initialsOf(String name) {
    final parts = name.trim().split(RegExp(r'\s+'));
    if (parts.isEmpty || parts.first.isEmpty) return '؟';
    if (parts.length == 1) return parts.first.substring(0, 1);
    return '${parts[0].substring(0, 1)}.${parts[1].substring(0, 1)}';
  }

  @override
  Widget build(BuildContext context) {
    final currentUser = context.watch<AuthService>().currentUser;
    final userName = currentUser?.name ?? 'مستخدم';
    return Scaffold(
      appBar: const ScreenTopBar(title: 'بلاغ عطل جديد'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                children: [
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.maintenance.withOpacity(0.06),
                      border: Border.all(color: AppColors.maintenance.withOpacity(0.16)),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: Row(
                      children: [
                        CircleAvatar(radius: 18, backgroundColor: const Color(0x1F2B3487), child: Text(_initialsOf(userName), style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: AppColors.maintenance))),
                        const SizedBox(width: 10),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(userName, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold)),
                            const Text('رافع البلاغ (تلقائيًا من حسابك)', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  const _FieldLabel('الخط / الموقع'),
                  DropdownButtonFormField<String>(
                    value: _line,
                    decoration: _fieldDecoration(),
                    items: _lines.map((l) => DropdownMenuItem(value: l, child: Text(l))).toList(),
                    onChanged: (v) => setState(() => _line = v ?? _line),
                  ),
                  const SizedBox(height: 14),
                  const _FieldLabel('تفاصيل الموقع (اختياري)'),
                  TextField(
                    controller: _locationDetailCtrl,
                    decoration: _fieldDecoration(hint: 'مثال: الإدارة، بوابة الاستقبال...'),
                  ),
                  const SizedBox(height: 14),
                  const _FieldLabel('المعدة'),
                  TextField(controller: _equipmentCtrl, decoration: _fieldDecoration()),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const _FieldLabel('وصف العطل'),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  TextField(
                    controller: _descriptionCtrl,
                    minLines: 3,
                    maxLines: 5,
                    onChanged: (_) => setState(() {}),
                    decoration: _fieldDecoration(hint: 'مثال: توقف مفاجئ — صوت غير طبيعي بالمحرك'),
                  ),
                  const SizedBox(height: 16),
                  const InfoNote(
                    text: 'سيصل إشعار فوري لمسؤولَي الصيانة + رسالة في جروب واتساب الصيانة',
                    color: AppColors.production,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(color: AppColors.maintenance)))
                : PrimaryButton(
                    label: 'إرسال البلاغ',
                    color: _canSubmit ? AppColors.maintenance : AppColors.textFaint,
                    icon: Icons.send,
                    onPressed: _canSubmit ? _submit : null,
                  ),
          ],
        ),
      ),
    );
  }
}

class _FieldLabel extends StatelessWidget {
  final String text;
  const _FieldLabel(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
    );
  }
}

InputDecoration _fieldDecoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
