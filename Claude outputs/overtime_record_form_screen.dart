import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_widgets.dart';

/// نموذج تسجيل (أو تعديل) عمل إضافي واحد. الإلزامي: التاريخ ووصف العمل فقط؛
/// كل ما عداه اختياري (السبب، الوقت، الموقع، الخطوط، المنتج، الباتش، عدد
/// العمال، الأفراد) والتقرير يعرض فقط ما عُبّئ. يرجع true عند الحفظ بنجاح.
class OvertimeRecordFormScreen extends StatefulWidget {
  final DateTime initialDate;
  final OvertimeRecord? existing;

  const OvertimeRecordFormScreen({super.key, required this.initialDate, this.existing});

  @override
  State<OvertimeRecordFormScreen> createState() => _OvertimeRecordFormScreenState();
}

class _OvertimeRecordFormScreenState extends State<OvertimeRecordFormScreen> {
  static const List<String> _quickLocations = ['مصنع الرجال', 'مصنع النساء', 'المستودع العام'];

  late DateTime _date;
  final TextEditingController _work = TextEditingController();
  final TextEditingController _reason = TextEditingController();
  final TextEditingController _location = TextEditingController();
  final TextEditingController _lines = TextEditingController();
  final TextEditingController _product = TextEditingController();
  final TextEditingController _batch = TextEditingController();
  final TextEditingController _workers = TextEditingController();

  String? _start;
  String? _end;

  List<OvertimeEmployee> _allEmployees = const [];
  bool _loadingEmployees = true;
  String? _employeesError;
  final Set<String> _selectedIds = <String>{};

  /// أفراد كانوا في السجل ثم حُذفوا من القائمة الدائمة — لا يمكن إبقاؤهم عند
  /// الحفظ لأن السيرفر يستبدل الأفراد بقائمة المعرّفات المختارة.
  List<OvertimeEntry> _removedEntries = const [];

  bool _saving = false;
  String? _error;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    _date = widget.initialDate;
    final r = widget.existing;
    if (r != null) {
      _date = overtimeParseDate(r.workDate) ?? widget.initialDate;
      _work.text = r.workDescription;
      _reason.text = r.reason ?? '';
      _location.text = r.location ?? '';
      _lines.text = r.lines ?? '';
      _product.text = r.product ?? '';
      _batch.text = r.batch ?? '';
      _workers.text = r.workersCount?.toString() ?? '';
      _start = r.startTime;
      _end = r.endTime;
      for (final e in r.entries) {
        final id = e.employeeId;
        if (id != null) _selectedIds.add(id);
      }
      _removedEntries = r.entries.where((e) => e.employeeId == null).toList();
    }
    _loadEmployees();
  }

  @override
  void dispose() {
    _work.dispose();
    _reason.dispose();
    _location.dispose();
    _lines.dispose();
    _product.dispose();
    _batch.dispose();
    _workers.dispose();
    super.dispose();
  }

  Future<void> _loadEmployees() async {
    setState(() {
      _loadingEmployees = true;
      _employeesError = null;
    });
    try {
      final list = await OvertimeService.fetchEmployees();
      if (!mounted) return;
      setState(() {
        _allEmployees = list;
        _loadingEmployees = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _employeesError = overtimeErrorText(e);
        _loadingEmployees = false;
      });
    }
  }

  // ------------------------------- الاختيارات -------------------------------

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked != null) setState(() => _date = DateTime(picked.year, picked.month, picked.day));
  }

  String _formatTime(TimeOfDay t) =>
      '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

  TimeOfDay _parseTime(String? hhmm, TimeOfDay fallback) {
    if (hhmm == null) return fallback;
    final parts = hhmm.split(':');
    if (parts.length != 2) return fallback;
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h == null || m == null) return fallback;
    return TimeOfDay(hour: h, minute: m);
  }

  Future<void> _pickTime({required bool isStart}) async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _parseTime(isStart ? _start : _end, isStart ? const TimeOfDay(hour: 17, minute: 0) : const TimeOfDay(hour: 21, minute: 0)),
      builder: (ctx, child) => MediaQuery(
        data: MediaQuery.of(ctx).copyWith(alwaysUse24HourFormat: true),
        child: child!,
      ),
    );
    if (picked == null) return;
    setState(() {
      if (isStart) {
        _start = _formatTime(picked);
      } else {
        _end = _formatTime(picked);
      }
    });
  }

  Future<void> _pickEmployees() async {
    final result = await Navigator.of(context).push<Set<String>>(
      MaterialPageRoute(
        builder: (_) => _EmployeePickerPage(employees: _allEmployees, selected: Set<String>.from(_selectedIds)),
      ),
    );
    if (result == null) return;
    setState(() {
      _selectedIds
        ..clear()
        ..addAll(result);
    });
  }

  // --------------------------------- الحفظ ---------------------------------

  String? _nullIfEmpty(String s) {
    final t = s.trim();
    return t.isEmpty ? null : t;
  }

  Future<void> _save() async {
    final work = _work.text.trim();
    if (work.isEmpty) {
      setState(() => _error = 'اكتب وصف العمل الإضافي');
      return;
    }
    if ((_start == null) != (_end == null)) {
      setState(() => _error = 'حدّد وقت البداية والنهاية معًا، أو اترك الوقت فارغًا');
      return;
    }
    if (_start != null && _start == _end) {
      setState(() => _error = 'وقت البداية والنهاية متطابقان — غيّر أحدهما');
      return;
    }
    int? workers;
    final workersText = _workers.text.trim();
    if (workersText.isNotEmpty) {
      workers = int.tryParse(workersText);
      if (workers == null || workers < 1 || workers > 10000) {
        setState(() => _error = 'عدد العمال يجب أن يكون رقمًا بين ١ و ١٠٠٠٠');
        return;
      }
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final ids = _selectedIds.toList();
    try {
      if (_isEdit) {
        await OvertimeService.updateRecord(
          widget.existing!.id,
          workDate: overtimeIsoDate(_date),
          workDescription: work,
          reason: _nullIfEmpty(_reason.text),
          startTime: _start,
          endTime: _end,
          location: _nullIfEmpty(_location.text),
          lines: _nullIfEmpty(_lines.text),
          product: _nullIfEmpty(_product.text),
          batch: _nullIfEmpty(_batch.text),
          workersCount: workers,
          employeeIds: ids,
        );
      } else {
        await OvertimeService.createRecord(
          workDate: overtimeIsoDate(_date),
          workDescription: work,
          reason: _nullIfEmpty(_reason.text),
          startTime: _start,
          endTime: _end,
          location: _nullIfEmpty(_location.text),
          lines: _nullIfEmpty(_lines.text),
          product: _nullIfEmpty(_product.text),
          batch: _nullIfEmpty(_batch.text),
          workersCount: workers,
          employeeIds: ids,
        );
      }
      if (!mounted) return;
      notifyOvertimeChanged();
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = overtimeErrorText(e);
      });
    }
  }

  // ---------------------------------- الواجهة ----------------------------------

  Widget _label(String text, {bool required = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 6),
        child: Align(
          alignment: Alignment.centerRight,
          child: Text(required ? '$text *' : text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ),
      );

  Widget _textField(
    TextEditingController c, {
    String? hint,
    int maxLines = 1,
    int? maxLength,
    TextInputType? keyboardType,
    List<TextInputFormatter>? formatters,
  }) {
    return TextField(
      controller: c,
      maxLines: maxLines,
      keyboardType: keyboardType,
      inputFormatters: [
        if (maxLength != null) LengthLimitingTextInputFormatter(maxLength),
        ...?formatters,
      ],
      decoration: fieldDecoration(hint: hint),
    );
  }

  Widget _timeBox({required bool isStart}) {
    final value = isStart ? _start : _end;
    return Expanded(
      child: InkWell(
        onTap: () => _pickTime(isStart: isStart),
        borderRadius: BorderRadius.circular(13),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(13),
          ),
          child: Row(
            children: [
              const Icon(Icons.schedule, size: 18, color: AppColors.textMuted),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  value == null ? (isStart ? 'من (البداية)' : 'إلى (النهاية)') : overtimeTimeLabel(value),
                  style: TextStyle(
                    fontSize: 14,
                    color: value == null ? AppColors.textMuted : AppColors.textPrimary,
                    fontWeight: value == null ? FontWeight.normal : FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _employeesSection() {
    final selected = _allEmployees.where((e) => _selectedIds.contains(e.id)).toList();
    // معرّفات مختارة لم تصل في قائمة الأفراد (مثلًا فشل تحميل القائمة): نعدّها فقط.
    final unknownCount = _selectedIds.length - selected.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'الأفراد المشاركون (${overtimeCount(_selectedIds.length)})',
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            TextButton.icon(
              onPressed: _loadingEmployees || _allEmployees.isEmpty ? null : _pickEmployees,
              icon: const Icon(Icons.group_add_outlined, size: 18),
              label: const Text('اختيار الأفراد'),
              style: TextButton.styleFrom(foregroundColor: kOvertimeColor),
            ),
          ],
        ),
        if (_loadingEmployees)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: kOvertimeColor))),
          )
        else if (_employeesError != null)
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              InfoNote(text: _employeesError!, color: kOvertimeDanger, icon: Icons.error_outline),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: _loadEmployees,
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('إعادة تحميل الأفراد'),
                  style: TextButton.styleFrom(foregroundColor: kOvertimeColor),
                ),
              ),
            ],
          )
        else if (_allEmployees.isEmpty)
          const InfoNote(
            text: 'قائمة الأفراد فارغة — أضف الأفراد أولًا من تبويب «الأفراد» ثم ارجع هنا لاختيارهم.',
            color: kOvertimeColor,
            icon: Icons.info_outline,
          )
        else if (selected.isEmpty && unknownCount == 0)
          const Text('لم تختر أحدًا بعد — اضغط «اختيار الأفراد»', style: TextStyle(fontSize: 12.5, color: AppColors.textMuted))
        else
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: selected
                .map(
                  (e) => InputChip(
                    label: Text(e.employeeNumber == null ? e.name : '${e.name} (${overtimeNumberLabel(e.employeeNumber!)})'),
                    labelStyle: const TextStyle(fontSize: 12.5),
                    backgroundColor: kOvertimeColor.withOpacity(0.08),
                    side: BorderSide.none,
                    onDeleted: () => setState(() => _selectedIds.remove(e.id)),
                  ),
                )
                .toList(),
          ),
        if (_removedEntries.isNotEmpty) ...[
          const SizedBox(height: 10),
          InfoNote(
            text: 'في هذا السجل أفراد حُذفوا من القائمة الدائمة (${_removedEntries.map((e) => e.name).join('، ')}) — سيُزالون من السجل عند الحفظ.',
            color: kOvertimeColor,
            icon: Icons.warning_amber_rounded,
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final hours = overtimeHoursBetween(_start, _end);
    final showHours = hours != null && _start != _end;

    return Scaffold(
      appBar: ScreenTopBar(title: _isEdit ? 'تعديل عمل إضافي' : 'عمل إضافي جديد'),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _label('التاريخ', required: true),
              InkWell(
                onTap: _pickDate,
                borderRadius: BorderRadius.circular(13),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                  decoration: BoxDecoration(
                    color: AppColors.surface,
                    border: Border.all(color: AppColors.border),
                    borderRadius: BorderRadius.circular(13),
                  ),
                  child: Row(
                    children: [
                      const Icon(Icons.calendar_month_outlined, size: 20, color: kOvertimeColor),
                      const SizedBox(width: 10),
                      Text(
                        '${overtimeWeekdayName(_date)} ${overtimeDateLabel(overtimeIsoDate(_date))}',
                        style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 14),
              _label('العمل المنفَّذ', required: true),
              _textField(_work, hint: 'مثال: تعبئة طارئة لطلبية مستعجلة', maxLines: 2, maxLength: 1000),
              const SizedBox(height: 14),
              _label('سبب العمل الإضافي (اختياري)'),
              _textField(_reason, hint: 'لماذا تم العمل بعد الدوام؟', maxLines: 3, maxLength: 1000),
              const SizedBox(height: 14),
              _label('الوقت (اختياري)'),
              Row(
                children: [
                  _timeBox(isStart: true),
                  const SizedBox(width: 10),
                  _timeBox(isStart: false),
                  if (_start != null || _end != null)
                    IconButton(
                      tooltip: 'مسح الوقت',
                      icon: const Icon(Icons.close, size: 20, color: AppColors.textMuted),
                      onPressed: () => setState(() {
                        _start = null;
                        _end = null;
                      }),
                    ),
                ],
              ),
              if (showHours)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'المدة: ${overtimeHoursLabel(hours!)}${(_start!.compareTo(_end!) > 0) ? ' (تتجاوز منتصف الليل)' : ''}',
                    style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: kOvertimeColor),
                  ),
                ),
              const SizedBox(height: 14),
              _label('الموقع (اختياري)'),
              _textField(_location, hint: 'مثال: مصنع الرجال', maxLength: 120),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: _quickLocations
                    .map(
                      (loc) => ActionChip(
                        label: Text(loc, style: const TextStyle(fontSize: 12)),
                        backgroundColor: AppColors.surface,
                        side: const BorderSide(color: AppColors.border),
                        onPressed: () => setState(() => _location.text = loc),
                      ),
                    )
                    .toList(),
              ),
              const SizedBox(height: 14),
              _label('الخطوط (اختياري)'),
              _textField(_lines, hint: 'مثال: خط ٧ + خط ٨', maxLength: 200),
              const SizedBox(height: 14),
              _label('المنتج (اختياري)'),
              _textField(_product, hint: 'اسم المنتج', maxLength: 200),
              const SizedBox(height: 14),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _label('الباتش (اختياري)'),
                        _textField(_batch, hint: 'رقم الباتش', maxLength: 100),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _label('عدد العمال (اختياري)'),
                        _textField(
                          _workers,
                          hint: 'يُحسب من الأفراد',
                          maxLength: 5,
                          keyboardType: TextInputType.number,
                          formatters: [FilteringTextInputFormatter.digitsOnly],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: AppColors.surface,
                  border: Border.all(color: AppColors.border),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: _employeesSection(),
              ),
              if (_error != null) ...[
                const SizedBox(height: 14),
                InfoNote(text: _error!, color: kOvertimeDanger, icon: Icons.error_outline),
              ],
              const SizedBox(height: 18),
              PrimaryButton(
                label: _saving ? 'جارٍ الحفظ...' : (_isEdit ? 'حفظ التعديلات' : 'حفظ العمل الإضافي'),
                color: kOvertimeColor,
                icon: _saving ? null : Icons.check,
                onPressed: _saving ? null : _save,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// شاشة اختيار الأفراد المشاركين: بحث، "تحديد الكل" لنتائج البحث الحالية،
/// وزر تأكيد يرجع مجموعة المعرّفات المختارة.
class _EmployeePickerPage extends StatefulWidget {
  final List<OvertimeEmployee> employees;
  final Set<String> selected;

  const _EmployeePickerPage({required this.employees, required this.selected});

  @override
  State<_EmployeePickerPage> createState() => _EmployeePickerPageState();
}

class _EmployeePickerPageState extends State<_EmployeePickerPage> {
  late final Set<String> _selected = Set<String>.from(widget.selected);
  String _query = '';

  List<OvertimeEmployee> get _filtered {
    final q = _query.trim();
    if (q.isEmpty) return widget.employees;
    return widget.employees.where((e) => e.name.contains(q) || (e.employeeNumber ?? '').contains(q)).toList();
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;
    final allSelected = items.isNotEmpty && items.every((e) => _selected.contains(e.id));

    return Scaffold(
      appBar: const ScreenTopBar(title: 'اختيار الأفراد'),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
              child: TextField(
                onChanged: (v) => setState(() => _query = v),
                decoration: fieldDecoration(hint: 'بحث بالاسم أو الرقم الوظيفي').copyWith(
                  prefixIcon: const Icon(Icons.search, size: 20, color: AppColors.textMuted),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'المختارون: ${overtimeCount(_selected.length)} من ${overtimeCount(widget.employees.length)}',
                      style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                    ),
                  ),
                  TextButton(
                    onPressed: items.isEmpty
                        ? null
                        : () => setState(() {
                              if (allSelected) {
                                for (final e in items) {
                                  _selected.remove(e.id);
                                }
                              } else {
                                for (final e in items) {
                                  _selected.add(e.id);
                                }
                              }
                            }),
                    style: TextButton.styleFrom(foregroundColor: kOvertimeColor),
                    child: Text(allSelected ? 'إلغاء تحديد الكل' : 'تحديد الكل'),
                  ),
                ],
              ),
            ),
            Expanded(
              child: items.isEmpty
                  ? const Center(child: Text('لا يوجد فرد يطابق البحث', style: TextStyle(color: AppColors.textMuted)))
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: items.length,
                      itemBuilder: (context, i) {
                        final e = items[i];
                        final checked = _selected.contains(e.id);
                        return CheckboxListTile(
                          value: checked,
                          activeColor: kOvertimeColor,
                          controlAffinity: ListTileControlAffinity.leading,
                          title: Text(e.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600)),
                          subtitle: Text(
                            e.employeeNumber == null ? 'بدون رقم وظيفي' : 'الرقم الوظيفي: ${overtimeNumberLabel(e.employeeNumber!)}',
                            style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                          ),
                          onChanged: (v) => setState(() {
                            if (v == true) {
                              _selected.add(e.id);
                            } else {
                              _selected.remove(e.id);
                            }
                          }),
                        );
                      },
                    ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
              child: PrimaryButton(
                label: 'تم (${overtimeCount(_selected.length)})',
                color: kOvertimeColor,
                icon: Icons.check,
                onPressed: () => Navigator.of(context).pop(_selected),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
