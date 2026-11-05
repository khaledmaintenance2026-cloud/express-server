import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_widgets.dart';

/// يفتح شاشة اختيار فرد واحد من القائمة الدائمة (مع بحث بالاسم أو الرقم
/// الوظيفي) ويرجع الفرد المختار، أو null لو رجع المستخدم بلا اختيار. تُستعمل
/// لفتح "كشف الفرد" من تبويب التقارير.
Future<OvertimeEmployee?> pickOvertimeEmployee(BuildContext context) {
  return Navigator.of(context).push<OvertimeEmployee>(
    MaterialPageRoute(builder: (_) => const _EmployeeSinglePickPage()),
  );
}

class _EmployeeSinglePickPage extends StatefulWidget {
  const _EmployeeSinglePickPage();

  @override
  State<_EmployeeSinglePickPage> createState() => _EmployeeSinglePickPageState();
}

class _EmployeeSinglePickPageState extends State<_EmployeeSinglePickPage> {
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
    if (mounted) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
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

  @override
  Widget build(BuildContext context) {
    final items = _filtered;

    Widget body;
    if (_loading) {
      body = const Center(child: CircularProgressIndicator(color: kOvertimeColor));
    } else if (_error != null) {
      body = ListView(children: [OvertimeErrorView(message: _error!, onRetry: _load)]);
    } else if (_employees.isEmpty) {
      body = ListView(
        children: const [
          OvertimeEmptyState(
            icon: Icons.groups_outlined,
            text: 'قائمة الأفراد فارغة — أضف الأفراد أولًا من تبويب «الأفراد».',
          ),
        ],
      );
    } else if (items.isEmpty) {
      body = ListView(
        children: const [OvertimeEmptyState(icon: Icons.search_off, text: 'لا يوجد فرد يطابق البحث')],
      );
    } else {
      body = ListView.separated(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
        itemCount: items.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, i) {
          final e = items[i];
          final number = e.employeeNumber;
          final initial = e.name.trim().isEmpty ? '؟' : e.name.trim().substring(0, 1);
          return Material(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            child: InkWell(
              borderRadius: BorderRadius.circular(14),
              onTap: () => Navigator.of(context).pop(e),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  border: Border.all(color: AppColors.border),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 18,
                      backgroundColor: kOvertimeColor.withOpacity(0.1),
                      child: Text(initial, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: kOvertimeColor)),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(e.name, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                          Text(
                            number == null ? 'بدون رقم وظيفي' : 'الرقم الوظيفي: ${overtimeNumberLabel(number)}',
                            style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      );
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'اختيار فرد'),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 10),
              child: TextField(
                onChanged: (v) => setState(() => _query = v),
                decoration: fieldDecoration(hint: 'بحث بالاسم أو الرقم الوظيفي').copyWith(
                  prefixIcon: const Icon(Icons.search, size: 20, color: AppColors.textMuted),
                ),
              ),
            ),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}
