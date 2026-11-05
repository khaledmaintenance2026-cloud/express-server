import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// شاشة زر "+" في تبويب "الأعطال الطارئة" بلوحة الصيانة — كانت مخصّصة سابقًا
/// لبلاغ عطل مباشر يرفعه فريق الصيانة نفسه (بلا معدة/بلاغ إنتاج سابق). قرار
/// صريح من الإدارة (2026-09-23): حُوِّلت إلى "إنشاء مهمة عمل" — مهام عامة
/// داخل المصنع أو خارجه لا ترتبط بعطل فعلي في معدة (توصيل، نقل معدات، أعمال
/// إدارية...). تبقى kind = 'emergency' على السيرفر عمدًا (راجع isTask/taskScope
/// في MaintenanceReport وAppState.createMaintenanceTask) فتظهر ضمن نفس تبويب
/// "الأعطال الطارئة" وتتبع نفس دورة العمل والإشعارات تمامًا بلا أي كود جديد،
/// ولا علاقة لها إطلاقًا ببلاغات الإنتاج (production_incidents_screen.dart)
/// ولا بالأعمال الوقائية (maintenance_work_order_screen.dart) — كلاهما بلا
/// أي تغيير.
class MaintenanceNewReportScreen extends StatefulWidget {
  const MaintenanceNewReportScreen({super.key});

  @override
  State<MaintenanceNewReportScreen> createState() => _MaintenanceNewReportScreenState();
}

class _MaintenanceNewReportScreenState extends State<MaintenanceNewReportScreen> {
  String _scope = 'internal'; // 'internal' | 'external'
  final _locationCtrl = TextEditingController();
  final _descriptionCtrl = TextEditingController();
  // يدعم النظام تعيين أكثر من فني لنفس المهمة مباشرة عند الإنشاء، تمامًا
  // كأمر العمل الوقائي (راجع maintenance_work_order_screen.dart) — لكن هنا
  // اختياري: تركه فارغًا يُبقي المهمة "بانتظار التعيين" كأي بلاغ عادي.
  final Set<String> _selectedTechIds = {};
  bool _submitting = false;

  @override
  void dispose() {
    _locationCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  bool get _canSubmit =>
      !_submitting && _locationCtrl.text.trim().isNotEmpty && _descriptionCtrl.text.trim().isNotEmpty;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() => _submitting = true);
    try {
      await context.read<AppState>().createMaintenanceTask(
            taskScope: _scope,
            location: _locationCtrl.text.trim(),
            description: _descriptionCtrl.text.trim(),
            technicianIds: _selectedTechIds.toList(),
          );
      if (!mounted) return;
      Navigator.of(context).pop();
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('تم إنشاء المهمة')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('تعذّر إنشاء المهمة: $e')),
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
    final state = context.watch<AppState>();
    final currentUser = context.watch<AuthService>().currentUser;
    final userName = currentUser?.name ?? 'مستخدم';
    // مواقع مهام سابقة (بلا تكرار) — تُعرض كاقتراحات سريعة بدل كتابة نفس
    // الموقع من الصفر في كل مرة، مع بقاء الحقل نصًا حرًا يقبل أي موقع جديد.
    final previousLocations = state.previousTaskLocations;

    return Scaffold(
      appBar: const ScreenTopBar(title: 'إنشاء مهمة عمل'),
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
                            const Text('مُنشئ المهمة (تلقائيًا من حسابك)', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  const _FieldLabel('نوع المهمة'),
                  Row(
                    children: [
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('داخلية — داخل المصنع'),
                          selected: _scope == 'internal',
                          selectedColor: AppColors.maintenance.withOpacity(0.16),
                          labelStyle: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: _scope == 'internal' ? AppColors.maintenance : AppColors.textSecondary,
                          ),
                          onSelected: (_) => setState(() => _scope = 'internal'),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: ChoiceChip(
                          label: const Text('خارجية — خارج المصنع'),
                          selected: _scope == 'external',
                          selectedColor: AppColors.maintenance.withOpacity(0.16),
                          labelStyle: TextStyle(
                            fontWeight: FontWeight.w600,
                            color: _scope == 'external' ? AppColors.maintenance : AppColors.textSecondary,
                          ),
                          onSelected: (_) => setState(() => _scope = 'external'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const _FieldLabel('الموقع'),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  TextField(
                    controller: _locationCtrl,
                    onChanged: (_) => setState(() {}),
                    decoration: _fieldDecoration(hint: 'مثال: مستودع القطع، أو عند العميل — خارج المصنع'),
                  ),
                  if (previousLocations.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    const Text('مواقع سابقة (اضغط لتعبئتها):', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: previousLocations
                          .map((loc) => ActionChip(
                                label: Text(loc, style: const TextStyle(fontSize: 12)),
                                onPressed: () => setState(() => _locationCtrl.text = loc),
                              ))
                          .toList(),
                    ),
                  ],
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      const _FieldLabel('وصف عمل المهمة'),
                      const SizedBox(width: 6),
                      Text('إلزامي', style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: AppColors.warningText)),
                    ],
                  ),
                  TextField(
                    controller: _descriptionCtrl,
                    minLines: 3,
                    maxLines: 5,
                    onChanged: (_) => setState(() {}),
                    decoration: _fieldDecoration(hint: 'مثال: نقل معدات إلى المستودع الجديد'),
                  ),
                  const SizedBox(height: 14),
                  const _FieldLabel('الفني/الفنيون (اختياري — يمكن تعيينهم لاحقًا)'),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: state.technicians.map((t) {
                      final selected = _selectedTechIds.contains(t.id);
                      return FilterChip(
                        label: Text(t.name),
                        selected: selected,
                        selectedColor: AppColors.maintenance.withOpacity(0.14),
                        checkmarkColor: AppColors.maintenance,
                        labelStyle: TextStyle(color: selected ? AppColors.maintenance : AppColors.textSecondary, fontWeight: FontWeight.w600, fontSize: 12.5),
                        side: BorderSide(color: selected ? AppColors.maintenance : AppColors.border),
                        onSelected: (v) => setState(() {
                          if (v) {
                            _selectedTechIds.add(t.id);
                          } else {
                            _selectedTechIds.remove(t.id);
                          }
                        }),
                      );
                    }).toList(),
                  ),
                  const SizedBox(height: 16),
                  InfoNote(
                    text: _selectedTechIds.isEmpty
                        ? 'ستُنشأ المهمة بانتظار تعيين فني لاحقًا + إشعار ورسالة واتساب فورية لقسم الصيانة'
                        : 'ستبدأ المهمة "قيد التنفيذ" مباشرة بالفني/الفنيين المختارين + إشعار ورسالة واتساب فورية لقسم الصيانة',
                    color: AppColors.production,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            _submitting
                ? const Center(child: Padding(padding: EdgeInsets.all(10), child: CircularProgressIndicator(color: AppColors.maintenance)))
                : PrimaryButton(
                    label: 'إنشاء المهمة',
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
