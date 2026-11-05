import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/app_state.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// أمر عمل جديد لصيانة وقائية / أعمال أخرى — يبادر به مشرف الصيانة نفسه،
/// منفصل تمامًا عن بلاغات العطل الطارئ ولا علاقة له بقسم الإنتاج.
class MaintenanceWorkOrderScreen extends StatefulWidget {
  const MaintenanceWorkOrderScreen({super.key});

  @override
  State<MaintenanceWorkOrderScreen> createState() => _MaintenanceWorkOrderScreenState();
}

class _MaintenanceWorkOrderScreenState extends State<MaintenanceWorkOrderScreen> {
  String _line = kFacilityLocations.first;
  final _locationDetailCtrl = TextEditingController();
  final _equipmentCodeCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _reminderCtrl = TextEditingController(text: '30');
  // يدعم النظام الآن تعيين أكثر من فني لنفس أمر العمل مباشرة عند الإنشاء.
  final Set<String> _selectedTechIds = {};
  bool _submitting = false;

  final _lines = kFacilityLocations;

  /// يجمع القسم المختار من القائمة مع تفاصيل موقع حرة اختيارية — يسمح لفريق
  /// الصيانة بإنشاء أمر عمل وقائي لأي مكان فعلي في المصنع بدل حصره بأحد
  /// الأقسام الثلاثة الرئيسية فقط. نفس نمط _fullLocation في
  /// maintenance_new_report_screen.dart وsafety_permit_request_screen.dart.
  String get _fullLocation =>
      _locationDetailCtrl.text.trim().isEmpty ? _line : '$_line — ${_locationDetailCtrl.text.trim()}';

  @override
  void dispose() {
    _locationDetailCtrl.dispose();
    _equipmentCodeCtrl.dispose();
    _descCtrl.dispose();
    _reminderCtrl.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() => _submitting = true);
    try {
      await context.read<AppState>().createWorkOrder(
            facility: _fullLocation,
            description: _descCtrl.text.trim(),
            technicianIds: _selectedTechIds.toList(),
            reminderIntervalDays: int.tryParse(_reminderCtrl.text.trim()),
            equipmentCode: _equipmentCodeCtrl.text.trim().isEmpty ? null : _equipmentCodeCtrl.text.trim(),
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إنشاء أمر العمل الوقائي')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر إنشاء أمر العمل: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final canSubmit = !_submitting && _descCtrl.text.trim().isNotEmpty && _selectedTechIds.isNotEmpty;

    return Scaffold(
      appBar: const ScreenTopBar(title: 'أمر عمل وقائي جديد'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                children: [
                  const Text('الموقع / الخط', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    value: _line,
                    decoration: _decoration(),
                    items: _lines.map((l) => DropdownMenuItem(value: l, child: Text(l))).toList(),
                    onChanged: (v) => setState(() => _line = v ?? _line),
                  ),
                  const SizedBox(height: 14),
                  const Text('تفاصيل الموقع (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _locationDetailCtrl,
                    decoration: _decoration(hint: 'مثال: الإدارة، بوابة الاستقبال...'),
                  ),
                  const SizedBox(height: 14),
                  const Text('كود المكينة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _equipmentCodeCtrl,
                    decoration: _decoration(hint: 'مثال: CMP-03'),
                  ),
                  const SizedBox(height: 14),
                  const Text('البيان (وصف العمل المطلوب)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _descCtrl,
                    minLines: 3,
                    maxLines: 4,
                    onChanged: (_) => setState(() {}),
                    decoration: _decoration(hint: 'مثال: فحص وتشحيم لوحة الكهرباء الدورية'),
                  ),
                  const SizedBox(height: 14),
                  const Text('الفني المسؤول (يمكن اختيار أكثر من فني)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 8),
                  TechnicianChipPicker(
                    technicians: state.technicians,
                    selectedIds: _selectedTechIds,
                    color: AppColors.maintenance,
                    onToggle: (id) => setState(() {
                      if (_selectedTechIds.contains(id)) {
                        _selectedTechIds.remove(id);
                      } else {
                        _selectedTechIds.add(id);
                      }
                    }),
                  ),
                  const SizedBox(height: 14),
                  const Text('تكرار التذكير (كل كم يوم)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  TextField(
                    controller: _reminderCtrl,
                    keyboardType: TextInputType.number,
                    decoration: _decoration(hint: 'مثال: 30'),
                  ),
                  const SizedBox(height: 16),
                  const InfoNote(
                    text: 'عند حلول الموعد يصل تنبيه للمسؤول فقط — لا يُنشئ أمر عمل تلقائيًا، القرار لكم في كل مرة',
                    color: AppColors.maintenance,
                    icon: Icons.autorenew,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            if (_submitting)
              const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(color: AppColors.maintenance)))
            else
              PrimaryButton(
                label: 'إنشاء أمر العمل',
                color: canSubmit ? AppColors.maintenance : AppColors.textFaint,
                onPressed: canSubmit ? _submit : null,
              ),
          ],
        ),
      ),
    );
  }
}

InputDecoration _decoration({String? hint}) {
  return InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: AppColors.surface,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    border: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
    enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(13), borderSide: const BorderSide(color: AppColors.border)),
  );
}
