import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/app_state.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// رفع بلاغ صيانة من قسم السلامة — يستخدمها ضابط السلامة أثناء جولاته
/// (مراجعة تصاريح العمل، معاينة مواقع العمل) حين يلاحظ عطلًا يحتاج تدخل
/// الصيانة، لأي مكان في المصنع وليس فقط الأقسام التي يزورها بحكم صلاحيته.
/// يُرسَل البلاغ عبر نفس نقطة POST /api/work-orders (kind: emergency)
/// المستخدمة في MaintenanceNewReportScreen تمامًا — فيظهر البلاغ فورًا في
/// قائمة أوامر عمل الصيانة نفسها بلا أي خطوة تحويل وسيطة، ويصل نفس إشعار
/// واتساب الفوري لجروب الصيانة (راجع routes/workOrders.js على السيرفر، حيث
/// أُضيف دور 'safety' صراحة إلى جانب أدوار الصيانة على هذا المسار تحديدًا).
class SafetyMaintenanceReportScreen extends StatefulWidget {
  const SafetyMaintenanceReportScreen({super.key});

  @override
  State<SafetyMaintenanceReportScreen> createState() => _SafetyMaintenanceReportScreenState();
}

class _SafetyMaintenanceReportScreenState extends State<SafetyMaintenanceReportScreen> {
  String _line = kFacilityLocations.first;
  final _locationDetailCtrl = TextEditingController();
  final _issueCtrl = TextEditingController();
  final _descriptionCtrl = TextEditingController();
  bool _submitting = false;

  final _lines = kFacilityLocations;

  /// نفس نمط _fullLocation في maintenance_new_report_screen.dart تمامًا —
  /// يجمع القسم المختار مع تفاصيل موقع حرة اختيارية، ليقدر ضابط السلامة
  /// تحديد أي مكان فعلي في المصنع بدل حصره بأحد الأقسام الثلاثة الرئيسية.
  String get _fullLocation =>
      _locationDetailCtrl.text.trim().isEmpty ? _line : '$_line — ${_locationDetailCtrl.text.trim()}';

  @override
  void dispose() {
    _locationDetailCtrl.dispose();
    _issueCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  bool get _canSubmit => !_submitting && _descriptionCtrl.text.trim().isNotEmpty;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() => _submitting = true);
    try {
      await context.read<AppState>().createReport(
            equipment: _issueCtrl.text.trim(),
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const ScreenTopBar(title: 'رفع بلاغ صيانة'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                children: [
                  const SizedBox(height: 10),
                  const _FieldLabel('القسم / الموقع'),
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
                  const _FieldLabel('نوع المشكلة (اختياري)'),
                  TextField(
                    controller: _issueCtrl,
                    decoration: _fieldDecoration(hint: 'مثال: تسرب مياه، إضاءة معطلة، باب طوارئ...'),
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const _FieldLabel('وصف المشكلة'),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  TextField(
                    controller: _descriptionCtrl,
                    minLines: 3,
                    maxLines: 5,
                    onChanged: (_) => setState(() {}),
                    decoration: _fieldDecoration(hint: 'مثال: سلك كهرباء مكشوف بجانب رف المواد الخام'),
                  ),
                  const SizedBox(height: 16),
                  const InfoNote(
                    text: 'سيصل إشعار فوري لمسؤولَي الصيانة + رسالة في جروب واتساب الصيانة',
                    color: AppColors.safetyText,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(color: AppColors.safety)))
                : PrimaryButton(
                    label: 'إرسال البلاغ',
                    color: _canSubmit ? AppColors.safety : AppColors.textFaint,
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
