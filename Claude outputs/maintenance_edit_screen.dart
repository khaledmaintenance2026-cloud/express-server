import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_report.dart';
import '../../models/technician.dart';
import '../../services/app_state.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة "تعديل المهمة" — قرار صريح من الإدارة (2026-09-26): مسؤول الصيانة/
/// المدير يقدر يعدّل بيانات أي مهمة/بلاغ صيانة قائم (الوصف، الموقع، كود/اسم
/// المعدة، نوع المهمة)، يزيل فنيًا مُسنَدًا بعينه أو يضيف فنيًا جديدًا متاحًا،
/// أو يحذف المهمة نهائيًا بأي حالة — كل ذلك بلا حاجة لحذف المهمة وإعادة
/// إنشائها من الصفر لتصحيح خطأ بسيط. تبقى إضافة الفني هنا تستخدم نفس مسار
/// "إسناد أمر عمل" الإضافي المعتاد (لا يزيل أحدًا)، والإزالة مسار جديد منفصل
/// (راجع AppState.removeTechnicianFromWorkOrder). كل هذه القدرات مقيَّدة على
/// السيرفر فعليًا بـrequireRole('maintenance_manager') — إخفاء الأزرار هنا
/// عن غير المخوَّلين تحسين لتجربة الاستخدام فقط، وليس بديلًا عن ذلك التقييد.
class MaintenanceEditScreen extends StatefulWidget {
  final MaintenanceReport report;
  const MaintenanceEditScreen({super.key, required this.report});

  @override
  State<MaintenanceEditScreen> createState() => _MaintenanceEditScreenState();
}

class _MaintenanceEditScreenState extends State<MaintenanceEditScreen> {
  late final TextEditingController _descCtrl;
  late final TextEditingController _locationCtrl;
  late final TextEditingController _equipmentCtrl;
  late final TextEditingController _equipmentCodeCtrl;
  late String _taskScope;

  List<Technician>? _assignedTechnicians;
  bool _loadingTechnicians = true;
  final Set<String> _selectedNewTechIds = {};
  bool _savingFields = false;
  bool _addingTechnicians = false;
  String? _removingTechnicianId;

  bool get _isTask => widget.report.isTask;

  @override
  void initState() {
    super.initState();
    _descCtrl = TextEditingController(text: widget.report.description);
    _locationCtrl = TextEditingController(text: widget.report.line);
    _equipmentCtrl = TextEditingController(text: widget.report.equipment);
    _equipmentCodeCtrl = TextEditingController(text: widget.report.equipmentCode ?? '');
    _taskScope = widget.report.taskScope ?? 'internal';
    _loadTechnicians();
  }

  @override
  void dispose() {
    _descCtrl.dispose();
    _locationCtrl.dispose();
    _equipmentCtrl.dispose();
    _equipmentCodeCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadTechnicians() async {
    try {
      final list = await context.read<AppState>().fetchWorkOrderTechnicians(widget.report.id);
      if (!mounted) return;
      setState(() {
        _assignedTechnicians = list;
        _loadingTechnicians = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _loadingTechnicians = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر تحميل قائمة الفنيين: $e')));
    }
  }

  Future<void> _save() async {
    setState(() => _savingFields = true);
    try {
      final newEquipmentName = _isTask
          ? (_taskScope == 'external' ? 'مهمة خارجية' : 'مهمة داخلية')
          : _equipmentCtrl.text.trim();
      await context.read<AppState>().updateWorkOrder(
            widget.report.id,
            description: _descCtrl.text.trim(),
            facility: _locationCtrl.text.trim(),
            equipmentName: newEquipmentName,
            equipmentCode: _isTask ? null : _equipmentCodeCtrl.text.trim(),
            taskScope: _isTask ? _taskScope : null,
          );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم حفظ التعديلات')));
      Navigator.of(context).pop();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر الحفظ: $e')));
    } finally {
      if (mounted) setState(() => _savingFields = false);
    }
  }

  Future<void> _removeTechnician(Technician tech) async {
    setState(() => _removingTechnicianId = tech.id);
    try {
      await context.read<AppState>().removeTechnicianFromWorkOrder(widget.report.id, tech.id);
      if (!mounted) return;
      setState(() {
        _assignedTechnicians = (_assignedTechnicians ?? []).where((t) => t.id != tech.id).toList();
      });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تمت إزالة ${tech.name}')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّرت الإزالة: $e')));
    } finally {
      if (mounted) setState(() => _removingTechnicianId = null);
    }
  }

  Future<void> _addSelectedTechnicians() async {
    if (_selectedNewTechIds.isEmpty) return;
    setState(() => _addingTechnicians = true);
    try {
      await context.read<AppState>().assignTechnicians(widget.report.id, _selectedNewTechIds.toList());
      _selectedNewTechIds.clear();
      await _loadTechnicians();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تمت إضافة الفنيين')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّرت الإضافة: $e')));
    } finally {
      if (mounted) setState(() => _addingTechnicians = false);
    }
  }

  Future<void> _confirmDelete() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف نهائي', style: TextStyle(fontSize: 15)),
        content: Text(
          'سيُحذف "${widget.report.equipment} — ${widget.report.line}" نهائيًا من قاعدة البيانات على السيرفر — '
          'يختفي من كل الأجهزة، ويصل إشعار بذلك لجروب الصيانة والفنيين المُسنَدين. لا يمكن التراجع عن هذا الإجراء.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFFB3261E), foregroundColor: Colors.white),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('حذف'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await context.read<AppState>().deleteMaintenanceReport(widget.report.id);
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('تم حذف المهمة')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر الحذف: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = context.watch<AppState>();
    final assignedIds = (_assignedTechnicians ?? []).map((t) => t.id).toSet();
    final addableTechnicians = state.technicians.where((t) => !assignedIds.contains(t.id)).toList();

    return Scaffold(
      appBar: const ScreenTopBar(title: 'تعديل المهمة'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: ListView(
          children: [
            const SizedBox(height: 12),
            const Text('الوصف', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
            const SizedBox(height: 6),
            TextField(controller: _descCtrl, minLines: 3, maxLines: 5, decoration: fieldDecoration()),
            const SizedBox(height: 14),
            const Text('الموقع', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
            const SizedBox(height: 6),
            TextField(controller: _locationCtrl, decoration: fieldDecoration()),
            if (!_isTask) ...[
              const SizedBox(height: 14),
              const Text('اسم المعدة', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 6),
              TextField(controller: _equipmentCtrl, decoration: fieldDecoration()),
              const SizedBox(height: 14),
              const Text('كود المكينة (اختياري)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 6),
              TextField(controller: _equipmentCodeCtrl, decoration: fieldDecoration()),
            ],
            if (_isTask) ...[
              const SizedBox(height: 14),
              const Text('نوع المهمة', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: ChoiceChip(
                      label: const Text('داخلية'),
                      selected: _taskScope == 'internal',
                      selectedColor: AppColors.maintenance.withOpacity(0.16),
                      labelStyle: TextStyle(fontWeight: FontWeight.w600, color: _taskScope == 'internal' ? AppColors.maintenance : AppColors.textSecondary),
                      onSelected: (_) => setState(() => _taskScope = 'internal'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: ChoiceChip(
                      label: const Text('خارجية'),
                      selected: _taskScope == 'external',
                      selectedColor: AppColors.maintenance.withOpacity(0.16),
                      labelStyle: TextStyle(fontWeight: FontWeight.w600, color: _taskScope == 'external' ? AppColors.maintenance : AppColors.textSecondary),
                      onSelected: (_) => setState(() => _taskScope = 'external'),
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 20),
            PrimaryButton(
              label: 'حفظ التعديلات',
              color: AppColors.maintenance,
              onPressed: _savingFields ? null : _save,
            ),
            const SizedBox(height: 26),
            const Divider(),
            const SizedBox(height: 12),
            const Text('الفنيون المُسنَدون', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            if (_loadingTechnicians)
              const Center(child: Padding(padding: EdgeInsets.all(12), child: CircularProgressIndicator()))
            else if ((_assignedTechnicians ?? []).isEmpty)
              const Text('لا يوجد أي فني مُسنَد حاليًا', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted))
            else
              ...(_assignedTechnicians!.map((t) => Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: AppColors.surface,
                        border: Border.all(color: AppColors.border),
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(t.name, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold)),
                                Text('تخصص: ${t.specialty}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                              ],
                            ),
                          ),
                          _removingTechnicianId == t.id
                              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                              : InkWell(
                                  onTap: () => _removeTechnician(t),
                                  borderRadius: BorderRadius.circular(8),
                                  child: const Padding(
                                    padding: EdgeInsets.all(4),
                                    child: Icon(Icons.close, size: 18, color: Color(0xFFB3261E)),
                                  ),
                                ),
                        ],
                      ),
                    ),
                  ))),
            const SizedBox(height: 14),
            const Text('إضافة فني', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
            const SizedBox(height: 8),
            addableTechnicians.isEmpty
                ? const Text('لا يوجد فنيون آخرون لإضافتهم', style: TextStyle(fontSize: 12, color: AppColors.textMuted))
                : TechnicianChipPicker(
                    technicians: addableTechnicians,
                    selectedIds: _selectedNewTechIds,
                    color: AppColors.maintenance,
                    onToggle: (id) => setState(() {
                      if (_selectedNewTechIds.contains(id)) {
                        _selectedNewTechIds.remove(id);
                      } else {
                        _selectedNewTechIds.add(id);
                      }
                    }),
                  ),
            if (_selectedNewTechIds.isNotEmpty) ...[
              const SizedBox(height: 10),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton(
                  onPressed: _addingTechnicians ? null : _addSelectedTechnicians,
                  child: _addingTechnicians
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('إضافة الفنيين المحددين'),
                ),
              ),
            ],
            const SizedBox(height: 30),
            const Divider(),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: _confirmDelete,
                style: OutlinedButton.styleFrom(
                  foregroundColor: const Color(0xFFB3261E),
                  side: const BorderSide(color: Color(0xFFB3261E)),
                ),
                icon: const Icon(Icons.delete_outline),
                label: const Text('حذف المهمة نهائيًا'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
