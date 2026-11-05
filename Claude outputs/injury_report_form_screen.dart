import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/injury_report.dart';
import '../../services/app_state.dart';
import '../../services/auth_service.dart';
import '../../services/constants.dart';
import '../../theme/app_theme.dart';
import '../../widgets/body_diagram_drawer.dart';
import '../../widgets/common.dart';

/// هرم الضوابط (Hierarchy of Controls) بألوانه وأيقوناته — نفس ترتيب ومفاتيح
/// kHierarchyOfControlLabels في lib/models/injury_report.dart بالضبط، ونفس
/// الألوان الخمسة المستخدمة في التقرير المطبوع (راجع hierarchyOptions في
/// lib/services/injury_report_html.dart) حتى يبقى شكل الاستمارة والتقرير
/// المطبوع متطابقين بصريًا. مُعرَّف هنا (لا في injury_report.dart) لأنه يحمل
/// ألوان/أيقونات Flutter، خلافًا لبقية الثوابت هناك المستقلة عن أي إطار عمل.
const List<(String key, String label, Color color, IconData icon)> kHierarchyOfControls = [
  ('elimination', 'إزالة الخطر', Color(0xFFB03A2E), Icons.block),
  ('substitution', 'الإحلال (الاستبدال)', Color(0xFF3498A5), Icons.swap_horiz),
  ('engineering_control', 'الضوابط الهندسية', Color(0xFF7D5AA6), Icons.engineering),
  ('administrative_control', 'الضوابط الإدارية', Color(0xFF2EA86B), Icons.rule),
  ('ppe', 'توفير معدات الحماية الشخصية', Color(0xFF2470B8), Icons.health_and_safety),
];

/// شاشة إنشاء/تعديل تقرير تحقيق إصابة عمل (QMS-SAF-007) — استمارة من ٥ خطوات
/// تطابق الاستمارة الورقية بالضبط (راجع lib/models/injury_report.dart لكل
/// القوائم والمفاتيح المستخدمة). تُمرَّر existing عند التعديل (طالما التقرير
/// لا يزال "مفتوحًا" — السيرفر يرفض تعديل تقرير مُغلَق).
class InjuryReportFormScreen extends StatefulWidget {
  final InjuryReport? existing;
  const InjuryReportFormScreen({super.key, this.existing});

  @override
  State<InjuryReportFormScreen> createState() => _InjuryReportFormScreenState();
}

class _InjuryReportFormScreenState extends State<InjuryReportFormScreen> {
  int _currentStep = 0;
  bool _submitting = false;

  final _incidentNumberCtrl = TextEditingController();
  final _incidentLocationCtrl = TextEditingController();
  final _workdayPartOtherCtrl = TextEditingController();
  final _incidentDescriptionCtrl = TextEditingController();
  final _unsafeConditionCtrl = TextEditingController();
  final _unsafeActCtrl = TextEditingController();
  final _preventionChangesOtherCtrl = TextEditingController();
  final _preventionNotesCtrl = TextEditingController();
  final _writtenByCtrl = TextEditingController();
  final _writtenByTitleCtrl = TextEditingController();

  late String _department;
  DateTime _investigationDate = DateTime.now();
  final Set<String> _natureOfAccident = {};
  final Set<String> _injuryTypes = {};

  DateTime? _occurredAt;
  String? _workdayPart;
  bool _witnessStatements = false;
  bool _photographsTaken = false;
  bool _mapsDrawings = false;
  final Set<String> _ppeUsed = {};

  bool? _hadRewardIncentive;
  bool? _reportedBefore;
  bool? _similarIncidentsBefore;

  final Set<String> _hierarchyOfControls = {};

  /// خانة تفاصيل مستقلة لكل ضابط مختار — تُنشأ عند الحاجة (راجع
  /// _controlDetailsCtrlFor) بدل مربع نص واحد مشترك للجميع.
  final Map<String, TextEditingController> _controlDetailsCtrls = {};

  final Set<String> _fishboneCauses = {};
  final Set<String> _preventionChanges = {};

  final List<InjuryReportEmployee> _employees = [];
  final List<InjuryReportAction> _actions = [];
  final List<InjuryReportInvestigator> _investigators = [];

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    final existing = widget.existing;
    if (existing != null) {
      _incidentNumberCtrl.text = existing.incidentNumber ?? '';
      _incidentLocationCtrl.text = existing.incidentLocation;
      _workdayPartOtherCtrl.text = existing.workdayPartOther ?? '';
      _incidentDescriptionCtrl.text = existing.incidentDescription;
      _unsafeConditionCtrl.text = existing.unsafeConditionReason ?? '';
      _unsafeActCtrl.text = existing.unsafeActReason ?? '';
      _preventionChangesOtherCtrl.text = existing.preventionChangesOther ?? '';
      _preventionNotesCtrl.text = existing.preventionNotes ?? '';
      _writtenByCtrl.text = existing.writtenBy ?? '';
      _writtenByTitleCtrl.text = existing.writtenByTitle ?? '';

      _department = existing.department;
      _investigationDate = existing.investigationDate;
      _natureOfAccident.addAll(existing.natureOfAccident);
      _injuryTypes.addAll(existing.injuryTypes);

      _occurredAt = existing.occurredAt;
      _workdayPart = existing.workdayPart;
      _witnessStatements = existing.witnessStatements;
      _photographsTaken = existing.photographsTaken;
      _mapsDrawings = existing.mapsDrawings;
      _ppeUsed.addAll(existing.ppeUsed);

      _hadRewardIncentive = existing.hadRewardIncentive;
      _reportedBefore = existing.reportedBefore;
      _similarIncidentsBefore = existing.similarIncidentsBefore;

      _hierarchyOfControls.addAll(existing.hierarchyOfControls);
      existing.controlDetails.forEach((key, value) => _controlDetailsCtrlFor(key).text = value);
      _fishboneCauses.addAll(existing.fishboneCauses);
      _preventionChanges.addAll(existing.preventionChanges);

      _employees.addAll(existing.employees);
      _actions.addAll(existing.actions);
      _investigators.addAll(existing.investigators);
    } else {
      final user = context.read<AuthService>().currentUser;
      _department = user?.safetyFacility ?? kFacilityLocations.first;
      _writtenByCtrl.text = user?.name ?? '';
    }
  }

  @override
  void dispose() {
    _incidentNumberCtrl.dispose();
    _incidentLocationCtrl.dispose();
    _workdayPartOtherCtrl.dispose();
    _incidentDescriptionCtrl.dispose();
    _unsafeConditionCtrl.dispose();
    _unsafeActCtrl.dispose();
    for (final c in _controlDetailsCtrls.values) {
      c.dispose();
    }
    _preventionChangesOtherCtrl.dispose();
    _preventionNotesCtrl.dispose();
    _writtenByCtrl.dispose();
    _writtenByTitleCtrl.dispose();
    super.dispose();
  }

  /// يُرجع مربع نص تفاصيل الضابط الخاص بمفتاح hierarchyOfControl معيّن،
  /// وينشئه أول مرة لو لم يكن موجودًا بعد (راجع _controlDetailsCtrls أعلاه).
  TextEditingController _controlDetailsCtrlFor(String key) {
    return _controlDetailsCtrls.putIfAbsent(key, () => TextEditingController());
  }

  void _toggle(Set<String> set, String key) {
    setState(() {
      if (set.contains(key)) {
        set.remove(key);
      } else {
        set.add(key);
      }
    });
  }

  Future<void> _pickInvestigationDate() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _investigationDate,
      firstDate: DateTime(DateTime.now().year - 2),
      lastDate: DateTime(DateTime.now().year + 1),
    );
    if (date != null) setState(() => _investigationDate = date);
  }

  Future<void> _pickOccurredAt() async {
    final now = DateTime.now();
    final initial = _occurredAt ?? now;
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(now.year - 2),
      lastDate: DateTime(now.year + 1),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(initial));
    if (time == null) return;
    setState(() => _occurredAt = DateTime(date.year, date.month, date.day, time.hour, time.minute));
  }

  String _formatDate(DateTime dt) {
    final d = dt.day.toString().padLeft(2, '0');
    final m = dt.month.toString().padLeft(2, '0');
    return '$d/$m/${dt.year}';
  }

  String _formatDateTime(DateTime dt) {
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '${_formatDate(dt)} — $h:$mi';
  }

  Future<void> _addOrEditEmployee({InjuryReportEmployee? existing, int? index}) async {
    final result = await Navigator.of(context).push<InjuryReportEmployee>(
      MaterialPageRoute(builder: (_) => _EmployeeFormScreen(existing: existing)),
    );
    if (result == null) return;
    setState(() {
      if (index != null) {
        _employees[index] = result;
      } else {
        _employees.add(result);
      }
    });
  }

  Future<void> _addOrEditAction({InjuryReportAction? existing, int? index}) async {
    final result = await showDialog<InjuryReportAction>(
      context: context,
      builder: (_) => _ActionFormDialog(existing: existing),
    );
    if (result == null) return;
    setState(() {
      if (index != null) {
        _actions[index] = result;
      } else {
        _actions.add(result);
      }
    });
  }

  Future<void> _addOrEditInvestigator({InjuryReportInvestigator? existing, int? index}) async {
    final result = await showDialog<InjuryReportInvestigator>(
      context: context,
      builder: (_) => _InvestigatorFormDialog(existing: existing),
    );
    if (result == null) return;
    setState(() {
      if (index != null) {
        _investigators[index] = result;
      } else {
        _investigators.add(result);
      }
    });
  }

  void _jumpToStepWithError(int step, String message) {
    setState(() => _currentStep = step);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _submit() async {
    if (_incidentLocationCtrl.text.trim().isEmpty) {
      return _jumpToStepWithError(1, 'موقع الحادث بالتفصيل إلزامي');
    }
    if (_occurredAt == null) {
      return _jumpToStepWithError(1, 'تاريخ ووقت الحادث إلزاميان');
    }
    if (_incidentDescriptionCtrl.text.trim().isEmpty) {
      return _jumpToStepWithError(1, 'وصف الحادثة إلزامي');
    }

    setState(() => _submitting = true);
    final draft = InjuryReport(
      id: widget.existing?.id ?? '',
      incidentNumber: _incidentNumberCtrl.text.trim().isEmpty ? null : _incidentNumberCtrl.text.trim(),
      department: _department,
      investigationDate: _investigationDate,
      natureOfAccident: _natureOfAccident.toList(),
      injuryTypes: _injuryTypes.toList(),
      incidentLocation: _incidentLocationCtrl.text.trim(),
      occurredAt: _occurredAt!,
      workdayPart: _workdayPart,
      workdayPartOther: _workdayPart == 'other' && _workdayPartOtherCtrl.text.trim().isNotEmpty ? _workdayPartOtherCtrl.text.trim() : null,
      witnessStatements: _witnessStatements,
      photographsTaken: _photographsTaken,
      mapsDrawings: _mapsDrawings,
      ppeUsed: _ppeUsed.toList(),
      incidentDescription: _incidentDescriptionCtrl.text.trim(),
      unsafeConditionReason: _unsafeConditionCtrl.text.trim().isEmpty ? null : _unsafeConditionCtrl.text.trim(),
      unsafeActReason: _unsafeActCtrl.text.trim().isEmpty ? null : _unsafeActCtrl.text.trim(),
      hadRewardIncentive: _hadRewardIncentive,
      reportedBefore: _reportedBefore,
      similarIncidentsBefore: _similarIncidentsBefore,
      hierarchyOfControls: _hierarchyOfControls.toList(),
      controlDetails: {
        for (final key in _hierarchyOfControls)
          if ((_controlDetailsCtrls[key]?.text.trim() ?? '').isNotEmpty) key: _controlDetailsCtrls[key]!.text.trim(),
      },
      fishboneCauses: _fishboneCauses.toList(),
      preventionChanges: _preventionChanges.toList(),
      preventionChangesOther:
          _preventionChanges.contains('other') && _preventionChangesOtherCtrl.text.trim().isNotEmpty ? _preventionChangesOtherCtrl.text.trim() : null,
      preventionNotes: _preventionNotesCtrl.text.trim().isEmpty ? null : _preventionNotesCtrl.text.trim(),
      writtenBy: _writtenByCtrl.text.trim().isEmpty ? null : _writtenByCtrl.text.trim(),
      writtenByTitle: _writtenByTitleCtrl.text.trim().isEmpty ? null : _writtenByTitleCtrl.text.trim(),
      reportedBy: '',
      createdAt: DateTime.now(),
      employees: _employees,
      actions: _actions,
      investigators: _investigators,
    );

    try {
      final state = context.read<AppState>();
      if (_isEdit) {
        await state.updateInjuryReportCloud(widget.existing!.id, draft);
      } else {
        await state.createInjuryReportCloud(draft);
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_isEdit ? 'تم حفظ تعديلات التقرير' : 'تم حفظ تقرير التحقيق')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('تعذّر حفظ التقرير: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ScreenTopBar(title: _isEdit ? 'تعديل تقرير الإصابة' : 'تقرير تحقيق إصابة عمل جديد'),
      body: Theme(
        data: Theme.of(context).copyWith(
          colorScheme: Theme.of(context).colorScheme.copyWith(primary: AppColors.safety),
        ),
        child: Stepper(
          currentStep: _currentStep,
          onStepTapped: (i) => setState(() => _currentStep = i),
          controlsBuilder: (context, details) => Padding(
            padding: const EdgeInsets.only(top: 14, bottom: 6),
            child: Row(
              children: [
                if (_currentStep < 4)
                  Expanded(
                    child: PrimaryButton(
                      label: 'التالي',
                      color: AppColors.safety,
                      onPressed: () => setState(() => _currentStep++),
                    ),
                  ),
                if (_currentStep == 4)
                  Expanded(
                    child: PrimaryButton(
                      label: _submitting ? 'جارٍ الحفظ...' : (_isEdit ? 'حفظ التعديلات' : 'حفظ التقرير'),
                      color: AppColors.safety,
                      onPressed: _submitting ? null : _submit,
                    ),
                  ),
                if (_currentStep > 0) ...[
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => setState(() => _currentStep--),
                      child: const Text('السابق'),
                    ),
                  ),
                ],
              ],
            ),
          ),
          steps: [
            Step(
              title: const Text('بيانات الحادث والمصابون'),
              isActive: _currentStep >= 0,
              state: _currentStep > 0 ? StepState.complete : StepState.indexed,
              content: _buildStep0(),
            ),
            Step(
              title: const Text('ظروف الحادث'),
              isActive: _currentStep >= 1,
              state: _currentStep > 1 ? StepState.complete : StepState.indexed,
              content: _buildStep1(),
            ),
            Step(
              title: const Text('تحليل السبب الجذري'),
              isActive: _currentStep >= 2,
              state: _currentStep > 2 ? StepState.complete : StepState.indexed,
              content: _buildStep2(),
            ),
            Step(
              title: const Text('هرم الضوابط والإجراءات'),
              isActive: _currentStep >= 3,
              state: _currentStep > 3 ? StepState.complete : StepState.indexed,
              content: _buildStep3(),
            ),
            Step(
              title: const Text('الاعتماد وفريق التحقيق'),
              isActive: _currentStep >= 4,
              state: StepState.indexed,
              content: _buildStep4(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildStep0() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _label('رقم الحادث (اختياري)'),
        TextField(controller: _incidentNumberCtrl, decoration: _decoration(hint: 'مثال: INC-2026-014')),
        const SizedBox(height: 14),
        _label('القسم'),
        DropdownButtonFormField<String>(
          value: _department,
          decoration: _decoration(),
          items: kFacilityLocations.map((f) => DropdownMenuItem(value: f, child: Text(f))).toList(),
          onChanged: (v) => setState(() => _department = v ?? _department),
        ),
        const SizedBox(height: 14),
        _label('تاريخ التحقيق'),
        _DateField(value: _investigationDate, formatter: _formatDate, onTap: _pickInvestigationDate),
        const SizedBox(height: 14),
        _label('طبيعة الحادث (اختر واحدًا أو أكثر)'),
        const SizedBox(height: 8),
        _MultiChipGroup(options: kNatureOfAccidentLabels, selected: _natureOfAccident, onToggle: (k) => _toggle(_natureOfAccident, k)),
        const SizedBox(height: 14),
        _label('نوع الإصابة/المرض (اختر واحدًا أو أكثر)'),
        const SizedBox(height: 8),
        _MultiChipGroup(options: kInjuryTypeLabels, selected: _injuryTypes, onToggle: (k) => _toggle(_injuryTypes, k)),
        const SizedBox(height: 20),
        Row(
          children: [
            const Expanded(child: Text('الموظفون المصابون', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold))),
            TextButton.icon(
              onPressed: () => _addOrEditEmployee(),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('إضافة مصاب'),
            ),
          ],
        ),
        if (_employees.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Text('لم تُضف بيانات أي موظف مصاب بعد', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          )
        else
          ..._employees.asMap().entries.map((entry) {
            final i = entry.key;
            final e = entry.value;
            return _ListItemCard(
              title: e.employeeName,
              subtitle: [
                if (e.jobTitle != null && e.jobTitle!.isNotEmpty) e.jobTitle!,
                if (e.bodyPartsAffected.isNotEmpty) multiLabel(kBodyPartLabels, e.bodyPartsAffected),
              ].join(' — '),
              trailingBadge: e.isFatality ? 'وفاة' : null,
              onEdit: () => _addOrEditEmployee(existing: e, index: i),
              onDelete: () => setState(() => _employees.removeAt(i)),
            );
          }),
      ],
    );
  }

  Widget _buildStep1() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _label('موقع الحادث بالتفصيل'),
        TextField(controller: _incidentLocationCtrl, decoration: _decoration(hint: 'مثال: خط الإنتاج رقم ٩ — منطقة التعبئة')),
        const SizedBox(height: 14),
        _label('تاريخ ووقت الحادث'),
        _DateField(value: _occurredAt, formatter: _formatDateTime, onTap: _pickOccurredAt, placeholder: 'اختر التاريخ والوقت'),
        const SizedBox(height: 14),
        _label('أي جزء من دوام الموظف حدث فيه الحادث؟'),
        DropdownButtonFormField<String?>(
          value: _workdayPart,
          decoration: _decoration(),
          items: [
            const DropdownMenuItem<String?>(value: null, child: Text('غير محدد')),
            ...kWorkdayPartLabels.entries.map((e) => DropdownMenuItem<String?>(value: e.key, child: Text(e.value))),
          ],
          onChanged: (v) => setState(() => _workdayPart = v),
        ),
        if (_workdayPart == 'other') ...[
          const SizedBox(height: 10),
          TextField(controller: _workdayPartOtherCtrl, decoration: _decoration(hint: 'وضّح...')),
        ],
        const SizedBox(height: 14),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('توجد خطابات شهود مكتوبة', style: TextStyle(fontSize: 13.5)),
          value: _witnessStatements,
          activeColor: AppColors.safety,
          onChanged: (v) => setState(() => _witnessStatements = v),
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('توجد صور من الموقع', style: TextStyle(fontSize: 13.5)),
          value: _photographsTaken,
          activeColor: AppColors.safety,
          onChanged: (v) => setState(() => _photographsTaken = v),
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('توجد رسوم / مخططات', style: TextStyle(fontSize: 13.5)),
          value: _mapsDrawings,
          activeColor: AppColors.safety,
          onChanged: (v) => setState(() => _mapsDrawings = v),
        ),
        const SizedBox(height: 10),
        _label('معدات الحماية الشخصية المستخدمة أثناء الحادث'),
        const SizedBox(height: 8),
        _MultiChipGroup(options: kInjuryPpeLabels, selected: _ppeUsed, onToggle: (k) => _toggle(_ppeUsed, k)),
        const SizedBox(height: 14),
        _label('صف، خطوة بخطوة، الأحداث التي قادت إلى الحادث'),
        TextField(
          controller: _incidentDescriptionCtrl,
          minLines: 4,
          maxLines: 7,
          decoration: _decoration(hint: 'أضف أسماء الآلات وقطع الغيار والمعدات وأي تفاصيل أخرى هامة'),
        ),
      ],
    );
  }

  Widget _buildStep2() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _label('ما سبب وجود الظروف غير الآمنة؟'),
        TextField(controller: _unsafeConditionCtrl, minLines: 2, maxLines: 4, decoration: _decoration()),
        const SizedBox(height: 14),
        _label('ما سبب حدوث التصرفات غير الآمنة؟'),
        TextField(controller: _unsafeActCtrl, minLines: 2, maxLines: 4, decoration: _decoration()),
        const SizedBox(height: 16),
        _YesNoRow(
          label: 'هل هناك مكافأة (كإنجاز العمل بسرعة) قد تُشجّع على الظروف/الأفعال غير الآمنة؟',
          value: _hadRewardIncentive,
          onChanged: (v) => setState(() => _hadRewardIncentive = v),
        ),
        _YesNoRow(
          label: 'هل تم الإبلاغ عن هذه الظروف/الأفعال قبل الحادث؟',
          value: _reportedBefore,
          onChanged: (v) => setState(() => _reportedBefore = v),
        ),
        _YesNoRow(
          label: 'هل حدثت حوادث أو أخطار كامنة مماثلة لهذا الحادث سابقًا؟',
          value: _similarIncidentsBefore,
          onChanged: (v) => setState(() => _similarIncidentsBefore = v),
        ),
        const SizedBox(height: 20),
        const Text('تحليل الأسباب بطريقة عظم السمكة (اختر كل الأسباب التي تنطبق)',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        const InfoNote(
          text: 'مقسّمة على فرعين: تصرفات غير آمنة (متعلقة بالفرد)، وظروف غير آمنة (بيئة العمل / أسلوب العمل / الأدوات والمعدات).',
          color: AppColors.safetyText,
          icon: Icons.fact_check_outlined,
        ),
        const SizedBox(height: 12),
        ...kFishboneBranches.map((branch) => Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(branch.$2, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 8),
                  _MultiChipGroup(options: branch.$3, selected: _fishboneCauses, onToggle: (k) => _toggle(_fishboneCauses, k)),
                ],
              ),
            )),
      ],
    );
  }

  Widget _buildStep3() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _label('هرم الضوابط (يمكن اختيار أكثر من ضابط)'),
        const SizedBox(height: 4),
        const Text('من الأعلى للأسفل: من الأكثر فعالية (إزالة الخطر) إلى الأقل فعالية (معدات الحماية الشخصية)',
            style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
        const SizedBox(height: 10),
        _HierarchyPyramid(selected: _hierarchyOfControls, onToggle: (k) => _toggle(_hierarchyOfControls, k)),
        if (_hierarchyOfControls.isNotEmpty) ...[
          const SizedBox(height: 14),
          ...kHierarchyOfControls.where((h) => _hierarchyOfControls.contains(h.$1)).map((h) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Container(width: 10, height: 10, margin: const EdgeInsets.only(left: 6), decoration: BoxDecoration(color: h.$3, shape: BoxShape.circle)),
                        _label('تفاصيل: ${h.$2}'),
                      ],
                    ),
                    const SizedBox(height: 6),
                    TextField(controller: _controlDetailsCtrlFor(h.$1), minLines: 2, maxLines: 3, decoration: _decoration()),
                  ],
                ),
              )),
        ],
        const SizedBox(height: 16),
        _label('ما التغييرات المطلوبة لمنع تكرار هذا الحادث؟'),
        const SizedBox(height: 8),
        _MultiChipGroup(options: kPreventionChangeLabels, selected: _preventionChanges, onToggle: (k) => _toggle(_preventionChanges, k)),
        if (_preventionChanges.contains('other')) ...[
          const SizedBox(height: 10),
          TextField(controller: _preventionChangesOtherCtrl, decoration: _decoration(hint: 'وضّح...')),
        ],
        const SizedBox(height: 14),
        _label('ما الذي يجب تنفيذه لتحقيق هذه الإجراءات؟'),
        TextField(controller: _preventionNotesCtrl, minLines: 2, maxLines: 4, decoration: _decoration()),
        const SizedBox(height: 20),
        Row(
          children: [
            const Expanded(child: Text('جدول متابعة الإجراءات', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold))),
            TextButton.icon(
              onPressed: () => _addOrEditAction(),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('إضافة إجراء'),
            ),
          ],
        ),
        if (_actions.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Text('لم تُضف إجراءات متابعة بعد', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          )
        else
          ..._actions.asMap().entries.map((entry) {
            final i = entry.key;
            final a = entry.value;
            return _ListItemCard(
              title: a.actionDescription,
              subtitle: [
                if (a.responsiblePerson != null && a.responsiblePerson!.isNotEmpty) 'المسؤول: ${a.responsiblePerson}',
                if (a.targetDate != null) 'الموعد: ${_formatDate(a.targetDate!)}',
              ].join(' — '),
              trailingBadge: a.done ? 'تم' : null,
              onEdit: () => _addOrEditAction(existing: a, index: i),
              onDelete: () => setState(() => _actions.removeAt(i)),
            );
          }),
      ],
    );
  }

  Widget _buildStep4() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _label('كتب التقرير بواسطة'),
        TextField(controller: _writtenByCtrl, decoration: _decoration()),
        const SizedBox(height: 14),
        _label('المسمى الوظيفي'),
        TextField(controller: _writtenByTitleCtrl, decoration: _decoration()),
        const SizedBox(height: 20),
        Row(
          children: [
            const Expanded(child: Text('أعضاء فريق التحقيق', style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold))),
            TextButton.icon(
              onPressed: () => _addOrEditInvestigator(),
              icon: const Icon(Icons.add, size: 18),
              label: const Text('إضافة عضو'),
            ),
          ],
        ),
        if (_investigators.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Text('لم تُضف أسماء فريق التحقيق بعد', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted)),
          )
        else
          ..._investigators.asMap().entries.map((entry) {
            final i = entry.key;
            final inv = entry.value;
            return _ListItemCard(
              title: inv.name,
              subtitle: inv.jobTitle ?? '',
              onEdit: () => _addOrEditInvestigator(existing: inv, index: i),
              onDelete: () => setState(() => _investigators.removeAt(i)),
            );
          }),
        const SizedBox(height: 6),
        const InfoNote(
          text: 'اعتماد التقرير نهائيًا (تم الاعتماد بواسطة/التاريخ) يتم من شاشة تفاصيل التقرير بعد الحفظ، وليس من هذه الاستمارة.',
          color: AppColors.safetyText,
          icon: Icons.info_outline,
        ),
      ],
    );
  }

  Widget _label(String text) => Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary));
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

class _MultiChipGroup extends StatelessWidget {
  final Map<String, String> options;
  final Set<String> selected;
  final void Function(String key) onToggle;
  const _MultiChipGroup({required this.options, required this.selected, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: options.entries.map((e) {
        final sel = selected.contains(e.key);
        return FilterChip(
          label: Text(e.value),
          selected: sel,
          selectedColor: AppColors.safety.withOpacity(0.22),
          onSelected: (_) => onToggle(e.key),
        );
      }).toList(),
    );
  }
}

/// عرض "هرم الضوابط" بشكل هرمي فعليًا (كل مستوى أعرض من الذي فوقه) بدل قائمة
/// شرائح مسطّحة بلا تمييز — يطابق شكل الهرم الملوّن بالاستمارة الورقية
/// الأصلية والتقرير المطبوع (راجع kHierarchyOfControls أعلاه لنفس الألوان).
/// اختيار متعدد (Set) — كل مستوى مضيء بلونه عند اختياره، ومحدَّد بلونه فقط
/// مع تعبئة خفيفة قبل الاختيار حتى يبقى الهرم واضحًا للعين من أول وهلة.
class _HierarchyPyramid extends StatelessWidget {
  final Set<String> selected;
  final void Function(String key) onToggle;
  const _HierarchyPyramid({required this.selected, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < kHierarchyOfControls.length; i++) ...[
          if (i > 0) const SizedBox(height: 4),
          _band(i),
        ],
      ],
    );
  }

  Widget _band(int i) {
    final (key, label, color, icon) = kHierarchyOfControls[i];
    final sel = selected.contains(key);
    // كل مستوى أعرض بـ١٥٪ من الذي فوقه — يبدأ بـ٤٠٪ (إزالة الخطر، أعلى الهرم
    // وأضيقه) وينتهي بـ١٠٠٪ (معدات الحماية الشخصية، قاعدة الهرم وأعرضها).
    final widthFactor = 0.40 + i * 0.15;
    return Center(
      child: FractionallySizedBox(
        widthFactor: widthFactor,
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => onToggle(key),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
              decoration: BoxDecoration(
                color: sel ? color : color.withOpacity(0.12),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: color, width: sel ? 0 : 1.2),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 17, color: sel ? Colors.white : color),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      label,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: sel ? Colors.white : color),
                    ),
                  ),
                  if (sel) ...[
                    const SizedBox(width: 6),
                    const Icon(Icons.check_circle, size: 16, color: Colors.white),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _YesNoRow extends StatelessWidget {
  final String label;
  final bool? value;
  final void Function(bool?) onChanged;
  const _YesNoRow({required this.label, required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              ChoiceChip(label: const Text('نعم'), selected: value == true, onSelected: (_) => onChanged(true)),
              ChoiceChip(label: const Text('لا'), selected: value == false, onSelected: (_) => onChanged(false)),
              ChoiceChip(label: const Text('غير محدد'), selected: value == null, onSelected: (_) => onChanged(null)),
            ],
          ),
        ],
      ),
    );
  }
}

/// جهة الإصابة من الجسم (أمامي/خلفي) — اختياري، بنفس نمط _YesNoRow تمامًا.
/// راجع kBodyInjurySideLabels لسبب وجود هذا الحقل.
class _BodySideRow extends StatelessWidget {
  final String? value;
  final void Function(String?) onChanged;
  const _BodySideRow({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('جهة الإصابة (اختياري — لدقّة التأشير على مخطط الجسم بالتقرير)',
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              ...kBodyInjurySideLabels.entries.map((e) => ChoiceChip(
                    label: Text(e.value),
                    selected: value == e.key,
                    onSelected: (_) => onChanged(value == e.key ? null : e.key),
                  )),
              ChoiceChip(label: const Text('غير محدد'), selected: value == null, onSelected: (_) => onChanged(null)),
            ],
          ),
        ],
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  final DateTime? value;
  final String Function(DateTime) formatter;
  final VoidCallback onTap;
  final String placeholder;
  const _DateField({required this.value, required this.formatter, required this.onTap, this.placeholder = 'اختر التاريخ'});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(13),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(13),
        ),
        child: Row(
          children: [
            const Icon(Icons.calendar_today_outlined, size: 16, color: AppColors.textMuted),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                value != null ? formatter(value!) : placeholder,
                style: TextStyle(fontSize: 13, color: value != null ? AppColors.textPrimary : AppColors.textFaint),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ListItemCard extends StatelessWidget {
  final String title;
  final String subtitle;
  final String? trailingBadge;
  final VoidCallback onEdit;
  final VoidCallback onDelete;
  const _ListItemCard({
    required this.title,
    required this.subtitle,
    this.trailingBadge,
    required this.onEdit,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
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
                Row(
                  children: [
                    Expanded(child: Text(title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.bold), overflow: TextOverflow.ellipsis)),
                    if (trailingBadge != null) ...[
                      const SizedBox(width: 6),
                      StatusPill(label: trailingBadge!, color: AppColors.successText, background: AppColors.successBg),
                    ],
                  ],
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textMuted), overflow: TextOverflow.ellipsis),
                ],
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.edit_outlined, size: 19, color: AppColors.textMuted),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            onPressed: onEdit,
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, size: 19, color: AppColors.textMuted),
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            onPressed: onDelete,
          ),
        ],
      ),
    );
  }
}

/// شاشة كاملة لإضافة/تعديل بيانات موظف مصاب واحد (الخطوة الأولى من الاستمارة).
class _EmployeeFormScreen extends StatefulWidget {
  final InjuryReportEmployee? existing;
  const _EmployeeFormScreen({this.existing});

  @override
  State<_EmployeeFormScreen> createState() => _EmployeeFormScreenState();
}

class _EmployeeFormScreenState extends State<_EmployeeFormScreen> {
  final _nameCtrl = TextEditingController();
  final _nationalityCtrl = TextEditingController();
  final _idNoCtrl = TextEditingController();
  final _ageCtrl = TextEditingController();
  final _deptCtrl = TextEditingController();
  final _jobTitleCtrl = TextEditingController();
  final _shiftCtrl = TextEditingController();
  final _lostDaysCtrl = TextEditingController(text: '0');
  final _monthsJobCtrl = TextEditingController();
  final _monthsCompanyCtrl = TextEditingController();
  final _injuryOtherCtrl = TextEditingController();

  String? _employmentType;
  bool _isFatality = false;
  final Set<String> _bodyParts = {};
  String? _bodyInjurySide;
  String? _bodyDiagramImage;
  // رابط المعاينة الكامل لرسمة محفوظة مسبقًا من الخادم (مسار نسبي + أصل
  // الخادم) — يُحسَب مرة واحدة عند فتح الشاشة فقط، ولا يتغيّر مع كل رسمة
  // جديدة (تلك تبقى محليًا في BodyDiagramDrawer كصورة data:image/... مباشرة).
  String? _initialBodyDiagramUrl;
  final Set<String> _injuryNature = {};

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    if (e != null) {
      _nameCtrl.text = e.employeeName;
      _nationalityCtrl.text = e.nationality ?? '';
      _idNoCtrl.text = e.employeeIdNo ?? '';
      _ageCtrl.text = e.age?.toString() ?? '';
      _deptCtrl.text = e.department ?? '';
      _jobTitleCtrl.text = e.jobTitle ?? '';
      _shiftCtrl.text = e.shift ?? '';
      _lostDaysCtrl.text = e.lostWorkDays.toString();
      _monthsJobCtrl.text = e.monthsInJob?.toString() ?? '';
      _monthsCompanyCtrl.text = e.monthsInCompany?.toString() ?? '';
      _injuryOtherCtrl.text = e.injuryNatureOther ?? '';
      _employmentType = e.employmentType;
      _isFatality = e.isFatality;
      _bodyParts.addAll(e.bodyPartsAffected);
      _bodyInjurySide = e.bodyInjurySide;
      _bodyDiagramImage = e.bodyDiagramImage;
      if (e.bodyDiagramImage != null && e.bodyDiagramImage!.startsWith('/')) {
        _initialBodyDiagramUrl = '$kApiOrigin${e.bodyDiagramImage}';
      }
      _injuryNature.addAll(e.injuryNature);
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _nationalityCtrl.dispose();
    _idNoCtrl.dispose();
    _ageCtrl.dispose();
    _deptCtrl.dispose();
    _jobTitleCtrl.dispose();
    _shiftCtrl.dispose();
    _lostDaysCtrl.dispose();
    _monthsJobCtrl.dispose();
    _monthsCompanyCtrl.dispose();
    _injuryOtherCtrl.dispose();
    super.dispose();
  }

  void _save() {
    if (_nameCtrl.text.trim().isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('اسم الموظف المصاب إلزامي')));
      return;
    }
    Navigator.of(context).pop(InjuryReportEmployee(
      employeeName: _nameCtrl.text.trim(),
      nationality: _nationalityCtrl.text.trim().isEmpty ? null : _nationalityCtrl.text.trim(),
      employeeIdNo: _idNoCtrl.text.trim().isEmpty ? null : _idNoCtrl.text.trim(),
      age: int.tryParse(_ageCtrl.text.trim()),
      department: _deptCtrl.text.trim().isEmpty ? null : _deptCtrl.text.trim(),
      jobTitle: _jobTitleCtrl.text.trim().isEmpty ? null : _jobTitleCtrl.text.trim(),
      shift: _shiftCtrl.text.trim().isEmpty ? null : _shiftCtrl.text.trim(),
      bodyPartsAffected: _bodyParts.toList(),
      bodyInjurySide: _bodyInjurySide,
      bodyDiagramImage: _bodyDiagramImage,
      lostWorkDays: int.tryParse(_lostDaysCtrl.text.trim()) ?? 0,
      employmentType: _employmentType,
      monthsInJob: int.tryParse(_monthsJobCtrl.text.trim()),
      monthsInCompany: int.tryParse(_monthsCompanyCtrl.text.trim()),
      injuryNature: _injuryNature.toList(),
      injuryNatureOther: _injuryOtherCtrl.text.trim().isEmpty ? null : _injuryOtherCtrl.text.trim(),
      isFatality: _isFatality,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: ScreenTopBar(title: widget.existing != null ? 'تعديل بيانات مصاب' : 'إضافة موظف مصاب'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: ListView(
                children: [
                  _field('اسم الموظف', _nameCtrl),
                  _field('الجنسية', _nationalityCtrl),
                  _field('الرقم الوظيفي', _idNoCtrl),
                  _field('العمر', _ageCtrl, keyboardType: TextInputType.number),
                  _field('الإدارة / القسم', _deptCtrl),
                  _field('المسمى الوظيفي', _jobTitleCtrl),
                  _field('الوردية', _shiftCtrl),
                  const SizedBox(height: 6),
                  const Text('نوع العقد', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String?>(
                    value: _employmentType,
                    decoration: _decoration(),
                    items: [
                      const DropdownMenuItem<String?>(value: null, child: Text('غير محدد')),
                      ...kEmploymentTypeLabels.entries.map((e) => DropdownMenuItem<String?>(value: e.key, child: Text(e.value))),
                    ],
                    onChanged: (v) => setState(() => _employmentType = v),
                  ),
                  const SizedBox(height: 14),
                  _field('عدد أيام الغياب', _lostDaysCtrl, keyboardType: TextInputType.number),
                  _field('عدد أشهر العمل بهذه الوظيفة', _monthsJobCtrl, keyboardType: TextInputType.number),
                  _field('عدد أشهر العمل بالشركة', _monthsCompanyCtrl, keyboardType: TextInputType.number),
                  const SizedBox(height: 6),
                  const Text('الجزء المتضرر في الجسم', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 8),
                  _MultiChipGroup(options: kBodyPartLabels, selected: _bodyParts, onToggle: (k) => setState(() {
                        if (_bodyParts.contains(k)) {
                          _bodyParts.remove(k);
                        } else {
                          _bodyParts.add(k);
                        }
                      })),
                  // جهة الإصابة (أمامي/خلفي) — اختياري، لكن تحديدها يجعل تعليم مخطط
                  // الجسم في التقرير المطبوع دقيقًا (دائرة واحدة بدل دائرة على كل
                  // الاحتمالات معًا لعدم معرفة الجهة). راجع kBodyInjurySideLabels.
                  _BodySideRow(value: _bodyInjurySide, onChanged: (v) => setState(() => _bodyInjurySide = v)),
                  const SizedBox(height: 12),
                  const Text('حدِّد مكان الإصابة بالضبط (ارسم على المخطط)',
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 8),
                  BodyDiagramDrawer(
                    bodyInjurySide: _bodyInjurySide,
                    initialImageUrl: _initialBodyDiagramUrl,
                    onChanged: (v) => _bodyDiagramImage = v,
                  ),
                  const SizedBox(height: 14),
                  const Text('طبيعة الإصابة (الأكثر شدة)', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
                  const SizedBox(height: 8),
                  _MultiChipGroup(options: kInjuryNatureLabels, selected: _injuryNature, onToggle: (k) => setState(() {
                        if (_injuryNature.contains(k)) {
                          _injuryNature.remove(k);
                        } else {
                          _injuryNature.add(k);
                        }
                      })),
                  if (_injuryNature.contains('other')) ...[
                    const SizedBox(height: 10),
                    _field('تفاصيل إضافية عن الإصابة', _injuryOtherCtrl),
                  ],
                  const SizedBox(height: 8),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('هذه حالة وفاة', style: TextStyle(fontSize: 13.5)),
                    value: _isFatality,
                    activeColor: AppColors.safety,
                    onChanged: (v) => setState(() => _isFatality = v),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
            PrimaryButton(label: 'حفظ بيانات المصاب', color: AppColors.safety, onPressed: _save),
          ],
        ),
      ),
    );
  }

  Widget _field(String label, TextEditingController ctrl, {TextInputType? keyboardType}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.textSecondary)),
          const SizedBox(height: 6),
          TextField(controller: ctrl, keyboardType: keyboardType, decoration: _decoration()),
        ],
      ),
    );
  }
}

/// نافذة إضافة/تعديل إجراء تصحيحي واحد في جدول المتابعة (الخطوة الرابعة).
class _ActionFormDialog extends StatefulWidget {
  final InjuryReportAction? existing;
  const _ActionFormDialog({this.existing});

  @override
  State<_ActionFormDialog> createState() => _ActionFormDialogState();
}

class _ActionFormDialogState extends State<_ActionFormDialog> {
  final _descCtrl = TextEditingController();
  final _responsibleCtrl = TextEditingController();
  DateTime? _targetDate;

  @override
  void initState() {
    super.initState();
    final a = widget.existing;
    if (a != null) {
      _descCtrl.text = a.actionDescription;
      _responsibleCtrl.text = a.responsiblePerson ?? '';
      _targetDate = a.targetDate;
    }
  }

  @override
  void dispose() {
    _descCtrl.dispose();
    _responsibleCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate: _targetDate ?? now,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year + 3),
    );
    if (date != null) setState(() => _targetDate = date);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.existing != null ? 'تعديل إجراء' : 'إضافة إجراء'),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: _descCtrl, minLines: 2, maxLines: 3, decoration: _decoration(hint: 'وصف الإجراء')),
            const SizedBox(height: 12),
            TextField(controller: _responsibleCtrl, decoration: _decoration(hint: 'الشخص المسؤول')),
            const SizedBox(height: 12),
            _DateField(
              value: _targetDate,
              formatter: (dt) => '${dt.day.toString().padLeft(2, '0')}/${dt.month.toString().padLeft(2, '0')}/${dt.year}',
              onTap: _pickDate,
              placeholder: 'الموعد المستهدف (اختياري)',
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('إلغاء')),
        TextButton(
          onPressed: () {
            if (_descCtrl.text.trim().isEmpty) return;
            Navigator.of(context).pop(InjuryReportAction(
              actionDescription: _descCtrl.text.trim(),
              responsiblePerson: _responsibleCtrl.text.trim().isEmpty ? null : _responsibleCtrl.text.trim(),
              targetDate: _targetDate,
              done: widget.existing?.done ?? false,
            ));
          },
          child: const Text('حفظ'),
        ),
      ],
    );
  }
}

/// نافذة إضافة/تعديل عضو في فريق التحقيق (الخطوة الخامسة).
class _InvestigatorFormDialog extends StatefulWidget {
  final InjuryReportInvestigator? existing;
  const _InvestigatorFormDialog({this.existing});

  @override
  State<_InvestigatorFormDialog> createState() => _InvestigatorFormDialogState();
}

class _InvestigatorFormDialogState extends State<_InvestigatorFormDialog> {
  final _nameCtrl = TextEditingController();
  final _titleCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    final inv = widget.existing;
    if (inv != null) {
      _nameCtrl.text = inv.name;
      _titleCtrl.text = inv.jobTitle ?? '';
    }
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _titleCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.existing != null ? 'تعديل عضو الفريق' : 'إضافة عضو للفريق'),
      content: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(controller: _nameCtrl, decoration: _decoration(hint: 'الاسم')),
          const SizedBox(height: 12),
          TextField(controller: _titleCtrl, decoration: _decoration(hint: 'المسمى الوظيفي (اختياري)')),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('إلغاء')),
        TextButton(
          onPressed: () {
            if (_nameCtrl.text.trim().isEmpty) return;
            Navigator.of(context).pop(InjuryReportInvestigator(
              name: _nameCtrl.text.trim(),
              jobTitle: _titleCtrl.text.trim().isEmpty ? null : _titleCtrl.text.trim(),
            ));
          },
          child: const Text('حفظ'),
        ),
      ],
    );
  }
}
