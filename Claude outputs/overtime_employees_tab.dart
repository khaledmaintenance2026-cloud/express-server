import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_person_screen.dart';
import 'overtime_widgets.dart';

/// تبويب "الأفراد": القائمة الدائمة لمن يعملون عملًا إضافيًا (اسم + رقم
/// وظيفي) — لا يشترط أن يكون للفرد حساب في التطبيق. إضافة وتعديل وحذف.
/// الاسم والرقم يُنسخان داخل كل سجل عمل إضافي، فحذف فرد لا يمسّ التقارير
/// السابقة، أما تعديل اسمه أو رقمه فيُحدَّث في السجلات القديمة أيضًا.
class OvertimeEmployeesTab extends StatefulWidget {
  const OvertimeEmployeesTab({super.key});

  @override
  State<OvertimeEmployeesTab> createState() => _OvertimeEmployeesTabState();
}

class _OvertimeEmployeesTabState extends State<OvertimeEmployeesTab> {
  List<OvertimeEmployee> _employees = const [];
  bool _loading = true;
  String? _error;
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() => _error = null);
    try {
      final list = await OvertimeService.fetchEmployees();
      if (!mounted) return;
      setState(() {
        _employees = list;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = overtimeErrorText(e);
        _loading = false;
      });
    }
  }

  List<OvertimeEmployee> get _filtered {
    final q = _query.trim();
    if (q.isEmpty) return _employees;
    return _employees.where((e) => e.name.contains(q) || (e.employeeNumber ?? '').contains(q)).toList();
  }

  Future<void> _openForm({OvertimeEmployee? existing}) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (ctx) => _EmployeeFormSheet(existing: existing),
    );
    if (saved == true) {
      notifyOvertimeChanged();
      await _load();
    }
  }

  /// كشف الفرد: أيام مشاركته وساعات كل يوم (الشهر الحالي أولًا).
  void _openPerson(OvertimeEmployee e) {
    final now = DateTime.now();
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OvertimePersonScreen(employee: e, initialMonth: DateTime(now.year, now.month, 1)),
      ),
    );
  }

  Future<void> _confirmDelete(OvertimeEmployee e) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف الفرد؟'),
        content: Text('سيُحذف "${e.name}" من قائمة الأفراد. التقارير السابقة تحتفظ باسمه ورقمه كما هي.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('إلغاء')),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('حذف', style: TextStyle(color: kOvertimeDanger)),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await OvertimeService.deleteEmployee(e.id);
      if (!mounted) return;
      showOvertimeSnack(context, 'تم حذف الفرد');
      notifyOvertimeChanged();
      await _load();
    } catch (err) {
      if (!mounted) return;
      showOvertimeSnack(context, overtimeErrorText(err), error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _filtered;

    Widget content;
    if (_loading) {
      content = const Center(child: CircularProgressIndicator(color: kOvertimeColor));
    } else if (_error != null && _employees.isEmpty) {
      content = ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [OvertimeErrorView(message: _error!, onRetry: _load)],
      );
    } else if (_employees.isEmpty) {
      content = ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [
          OvertimeEmptyState(
            icon: Icons.groups_outlined,
            text: 'لا يوجد أفراد في القائمة بعد.\nاضغط «إضافة فرد» لتسجيل اسم الموظف ورقمه الوظيفي — مرة واحدة فقط وتبقى القائمة دائمة.',
          ),
        ],
      );
    } else if (items.isEmpty) {
      content = ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: const [OvertimeEmptyState(icon: Icons.search_off, text: 'لا يوجد فرد يطابق البحث')],
      );
    } else {
      content = ListView.separated(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 90),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 10),
        itemBuilder: (context, i) => _EmployeeTile(
          employee: items[i],
          onOpen: () => _openPerson(items[i]),
          onEdit: () => _openForm(existing: items[i]),
          onDelete: () => _confirmDelete(items[i]),
        ),
      );
    }

    return Stack(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 14, 20, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                onChanged: (v) => setState(() => _query = v),
                decoration: fieldDecoration(hint: 'بحث بالاسم أو الرقم الوظيفي').copyWith(
                  prefixIcon: const Icon(Icons.search, size: 20, color: AppColors.textMuted),
                ),
              ),
              if (!_loading && _employees.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: Text(
                    'عدد الأفراد: ${overtimeCount(_employees.length)}',
                    style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                  ),
                ),
              if (_error != null && _employees.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 10),
                  child: InfoNote(text: _error!, color: kOvertimeDanger, icon: Icons.error_outline),
                ),
              const SizedBox(height: 10),
              Expanded(child: RefreshIndicator(onRefresh: _load, child: content)),
            ],
          ),
        ),
        Positioned(
          bottom: 20,
          left: 20,
          child: FloatingActionButton.extended(
            backgroundColor: kOvertimeColor,
            foregroundColor: Colors.white,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
            onPressed: () => _openForm(),
            icon: const Icon(Icons.person_add_alt_1_outlined),
            label: const Text('إضافة فرد', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }
}

class _EmployeeTile extends StatelessWidget {
  final OvertimeEmployee employee;
  final VoidCallback onOpen;
  final VoidCallback onEdit;
  final VoidCallback onDelete;

  const _EmployeeTile({required this.employee, required this.onOpen, required this.onEdit, required this.onDelete});

  String get _initial {
    final n = employee.name.trim();
    return n.isEmpty ? '؟' : n.substring(0, 1);
  }

  @override
  Widget build(BuildContext context) {
    final number = employee.employeeNumber;
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onOpen,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            border: Border.all(color: AppColors.border),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            children: [
              CircleAvatar(
                radius: 20,
                backgroundColor: kOvertimeColor.withOpacity(0.1),
                child: Text(_initial, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: kOvertimeColor)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(employee.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 2),
                    Text(
                      number == null ? 'بدون رقم وظيفي' : 'الرقم الوظيفي: ${overtimeNumberLabel(number)}',
                      style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                    const SizedBox(height: 2),
                    const Text(
                      'اضغط لعرض أيام الإضافي وساعاته',
                      style: TextStyle(fontSize: 11.5, color: kOvertimeColor),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'تعديل',
                icon: const Icon(Icons.edit_outlined, size: 20, color: AppColors.textMuted),
                onPressed: onEdit,
              ),
              IconButton(
                tooltip: 'حذف',
                icon: const Icon(Icons.delete_outline, size: 20, color: kOvertimeDanger),
                onPressed: onDelete,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// نموذج إضافة/تعديل فرد (ورقة سفلية). يُظهر رسالة السيرفر (مثل "الرقم
/// الوظيفي مسجّل لفرد آخر") داخل الورقة نفسها ولا يُغلقها عند الفشل.
class _EmployeeFormSheet extends StatefulWidget {
  final OvertimeEmployee? existing;
  const _EmployeeFormSheet({this.existing});

  @override
  State<_EmployeeFormSheet> createState() => _EmployeeFormSheetState();
}

class _EmployeeFormSheetState extends State<_EmployeeFormSheet> {
  late final TextEditingController _name = TextEditingController(text: widget.existing?.name ?? '');
  late final TextEditingController _number = TextEditingController(text: widget.existing?.employeeNumber ?? '');
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _number.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final number = _number.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'اكتب اسم الفرد');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (widget.existing == null) {
        await OvertimeService.addEmployee(name: name, employeeNumber: number.isEmpty ? null : number);
      } else {
        await OvertimeService.updateEmployee(widget.existing!.id, name: name, employeeNumber: number.isEmpty ? null : number);
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = overtimeErrorText(e);
      });
    }
  }

  Widget _label(String text) => Align(
        alignment: Alignment.centerRight,
        child: Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      );

  @override
  Widget build(BuildContext context) {
    final isEdit = widget.existing != null;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
        decoration: const BoxDecoration(
          color: AppColors.background,
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(isEdit ? 'تعديل بيانات الفرد' : 'إضافة فرد جديد',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 16),
              _label('الاسم'),
              const SizedBox(height: 6),
              TextField(
                controller: _name,
                textInputAction: TextInputAction.next,
                decoration: fieldDecoration(hint: 'اسم الموظف كما يظهر في التقرير'),
              ),
              const SizedBox(height: 12),
              _label('الرقم الوظيفي (اختياري)'),
              const SizedBox(height: 6),
              TextField(
                controller: _number,
                decoration: fieldDecoration(hint: 'مثال: 1024'),
              ),
              if (isEdit) ...[
                const SizedBox(height: 10),
                const InfoNote(
                  text: 'تعديل الاسم أو الرقم يُحدَّث أيضًا في التقارير السابقة.',
                  color: kOvertimeColor,
                  icon: Icons.info_outline,
                ),
              ],
              if (_error != null) ...[
                const SizedBox(height: 10),
                InfoNote(text: _error!, color: kOvertimeDanger, icon: Icons.error_outline),
              ],
              const SizedBox(height: 18),
              PrimaryButton(
                label: _saving ? 'جارٍ الحفظ...' : (isEdit ? 'حفظ التعديلات' : 'إضافة الفرد'),
                color: kOvertimeColor,
                onPressed: _saving ? null : _save,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
