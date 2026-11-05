import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_person_picker.dart';
import 'overtime_person_screen.dart';
import 'overtime_report_print_screen.dart';
import 'overtime_widgets.dart';

/// تبويب "التقارير": تقرير أي يوم أو أي شهر — يُعرض داخل التطبيق، ويُخرَج
/// كملف PDF للطباعة (جدول بأسماء الأفراد وأرقامهم وخانة التوقيع)، ويُرسل
/// ملخصه على واتساب (لجوال المسؤول نفسه أو لجروب الصيانة).
class OvertimeReportsTab extends StatefulWidget {
  const OvertimeReportsTab({super.key});

  @override
  State<OvertimeReportsTab> createState() => _OvertimeReportsTabState();
}

class _OvertimeReportsTabState extends State<OvertimeReportsTab> {
  bool _monthMode = false;
  late DateTime _day;
  late DateTime _month;
  OvertimeReport? _report;
  bool _loading = true;
  String? _error;
  bool _sending = false;
  int _requestId = 0;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _day = DateTime(now.year, now.month, now.day);
    _month = DateTime(now.year, now.month, 1);
    _load();
  }

  Future<void> _load() async {
    final id = ++_requestId;
    if (mounted) setState(() => _error = null);
    try {
      final report = _monthMode
          ? await OvertimeService.fetchReport(month: overtimeIsoMonth(_month))
          : await OvertimeService.fetchReport(date: overtimeIsoDate(_day));
      if (!mounted || id != _requestId) return;
      setState(() {
        _report = report;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || id != _requestId) return;
      setState(() {
        _error = overtimeErrorText(e);
        _loading = false;
      });
    }
  }

  void _reload() {
    setState(() {
      _report = null;
      _loading = true;
    });
    _load();
  }

  void _setMode(bool month) {
    if (_monthMode == month) return;
    setState(() {
      _monthMode = month;
      if (month) {
        _month = DateTime(_day.year, _day.month, 1);
      } else if (_day.year != _month.year || _day.month != _month.month) {
        _day = DateTime(_month.year, _month.month, 1);
      }
    });
    _reload();
  }

  void _shift(int step) {
    setState(() {
      if (_monthMode) {
        _month = DateTime(_month.year, _month.month + step, 1);
      } else {
        _day = DateTime(_day.year, _day.month, _day.day + step);
      }
    });
    _reload();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _monthMode ? _month : _day,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      helpText: _monthMode ? 'اختر أي يوم من الشهر المطلوب' : null,
    );
    if (picked == null) return;
    setState(() {
      if (_monthMode) {
        _month = DateTime(picked.year, picked.month, 1);
      } else {
        _day = DateTime(picked.year, picked.month, picked.day);
      }
    });
    _reload();
  }

  void _openPdf() {
    final report = _report;
    if (report == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => OvertimeReportPrintScreen(report: report)),
    );
  }

  Future<void> _sendWhatsapp() async {
    final toGroup = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Colors.transparent,
      builder: (ctx) => const _SendTargetSheet(),
    );
    if (toGroup == null || !mounted) return;
    setState(() => _sending = true);
    try {
      await OvertimeService.sendReportWhatsapp(
        date: _monthMode ? null : overtimeIsoDate(_day),
        month: _monthMode ? overtimeIsoMonth(_month) : null,
        toGroup: toGroup,
      );
      if (!mounted) return;
      setState(() => _sending = false);
      showOvertimeSnack(context, toGroup ? 'تم إرسال الملخص إلى الجروب' : 'تم إرسال الملخص إلى جوالك');
    } catch (e) {
      if (!mounted) return;
      setState(() => _sending = false);
      showOvertimeSnack(context, overtimeErrorText(e), error: true);
    }
  }

  // ---------------------------------- الواجهة ----------------------------------

  Widget _modeChip(String label, bool month) {
    final selected = _monthMode == month;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      showCheckmark: false,
      selectedColor: kOvertimeColor.withOpacity(0.15),
      backgroundColor: AppColors.surface,
      side: BorderSide(color: selected ? kOvertimeColor : AppColors.border),
      labelStyle: TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w700,
        color: selected ? kOvertimeColor : AppColors.textSecondary,
      ),
      onSelected: (_) => _setMode(month),
    );
  }

  Widget _kpis(OvertimeSummary s) {
    final rows = <Widget>[];
    if (_monthMode) {
      rows.add(Row(
        children: [
          KpiCard(value: overtimeCount(s.recordsCount), label: 'عدد الأعمال', valueColor: AppColors.maintenance),
          const SizedBox(width: 10),
          KpiCard(value: overtimeCount(s.daysCount), label: 'أيام الإضافي', valueColor: AppColors.maintenance),
          const SizedBox(width: 10),
          KpiCard(value: overtimeCount(s.employeesCount), label: 'عدد الأفراد', valueColor: AppColors.maintenance),
        ],
      ));
    } else {
      rows.add(Row(
        children: [
          KpiCard(value: overtimeCount(s.recordsCount), label: 'عدد الأعمال', valueColor: AppColors.maintenance),
          const SizedBox(width: 10),
          KpiCard(value: overtimeCount(s.employeesCount), label: 'عدد الأفراد', valueColor: AppColors.maintenance),
        ],
      ));
    }
    if (s.personHours > 0) {
      rows.add(const SizedBox(height: 10));
      rows.add(Row(
        children: [
          KpiCard(value: overtimeHoursLabel(s.personHours), label: 'إجمالي ساعات الأفراد', valueColor: kOvertimeColor),
        ],
      ));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
  }

  /// اختيار فرد من القائمة ثم فتح كشفه (أيامه وساعات كل يوم، لشهر أو سنة).
  Future<void> _pickPerson() async {
    final employee = await pickOvertimeEmployee(context);
    if (employee == null || !mounted) return;
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OvertimePersonScreen(employee: employee, initialMonth: _monthMode ? _month : _day),
      ),
    );
  }

  Widget _personPickerCard() {
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: _pickPerson,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            border: Border.all(color: kOvertimeColor.withOpacity(0.5)),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(color: kOvertimeColor.withOpacity(0.12), borderRadius: BorderRadius.circular(12)),
                child: const Icon(Icons.person_search_outlined, color: kOvertimeColor),
              ),
              const SizedBox(width: 12),
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('كشف فرد واحد', style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                    SizedBox(height: 2),
                    Text(
                      'اختر فردًا لتعرف أيام مشاركته في الإضافي وساعاته في كل يوم',
                      style: TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// فتح كشف الفرد (أيامه وساعات كل يوم) — لأفراد القائمة الحاليين فقط (من
  /// حُذف من القائمة يبقى اسمه في التقرير بلا كشف مستقل).
  void _openPerson(OvertimePersonSummary p) {
    final id = p.employeeId;
    if (id == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OvertimePersonScreen(
          employee: OvertimeEmployee(id: id, name: p.name, employeeNumber: p.employeeNumber),
          initialMonth: _month,
        ),
      ),
    );
  }

  Widget _personTile(int index, OvertimePersonSummary p) {
    final number = p.employeeNumber;
    final daysLine = overtimeDaysLine(p.days, monthMode: true, withHours: true);
    final canOpen = p.employeeId != null;
    return Material(
      color: AppColors.surface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: canOpen ? () => _openPerson(p) : null,
        child: _personTileBody(index, p, number, daysLine, canOpen),
      ),
    );
  }

  Widget _personTileBody(int index, OvertimePersonSummary p, String? number, String daysLine, bool canOpen) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 13,
            backgroundColor: kOvertimeColor.withOpacity(0.12),
            child: Text(
              overtimeCount(index + 1),
              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.bold, color: kOvertimeColor),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(p.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold)),
                if (number != null)
                  Text('الرقم الوظيفي: ${overtimeNumberLabel(number)}', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
                if (daysLine.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      'الأيام (وساعات كل يوم): $daysLine',
                      style: const TextStyle(fontSize: 11.5, color: AppColors.textSecondary, height: 1.5),
                    ),
                  ),
                if (canOpen)
                  const Padding(
                    padding: EdgeInsets.only(top: 3),
                    child: Text('اضغط لعرض ساعاته في كل يوم', style: TextStyle(fontSize: 11, color: kOvertimeColor)),
                  ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                p.hours > 0 ? overtimeHoursLabel(p.hours) : '—',
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: kOvertimeColor),
              ),
              Text(
                '${overtimeCount(p.recordsCount)} مرة — ${overtimeCount(p.daysCount)} يوم',
                style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted),
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _reportBody(OvertimeReport report) {
    final s = report.summary;
    final out = <Widget>[
      _kpis(s),
      const SizedBox(height: 12),
      PrimaryButton(label: 'تقرير PDF للطباعة', color: kOvertimeColor, icon: Icons.picture_as_pdf_outlined, onPressed: _openPdf),
      const SizedBox(height: 10),
      OutlinedButton.icon(
        onPressed: _sending ? null : _sendWhatsapp,
        icon: _sending
            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: kOvertimeColor))
            : const Icon(Icons.send_outlined, size: 19),
        label: Text(_sending ? 'جارٍ الإرسال...' : 'إرسال ملخص على واتساب'),
        style: OutlinedButton.styleFrom(
          foregroundColor: kOvertimeColor,
          side: const BorderSide(color: kOvertimeColor),
          padding: const EdgeInsets.symmetric(vertical: 14),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
    ];

    if (s.recordsWithoutHours > 0) {
      out.add(const SizedBox(height: 10));
      out.add(InfoNote(
        text: '${overtimeCount(s.recordsWithoutHours)} من الأعمال بلا وقت محدد، فلا تدخل ساعاتها في الإجماليات.',
        color: kOvertimeColor,
        icon: Icons.info_outline,
      ));
    }

    if (_monthMode && s.employees.isNotEmpty) {
      out.add(const SizedBox(height: 18));
      out.add(const OvertimeSectionTitle('ملخص الأفراد'));
      for (var i = 0; i < s.employees.length; i++) {
        out.add(_personTile(i, s.employees[i]));
        out.add(const SizedBox(height: 8));
      }
    }

    out.add(const SizedBox(height: 10));
    out.add(OvertimeSectionTitle(_monthMode ? 'تفاصيل الأعمال' : 'أعمال اليوم'));
    for (var i = 0; i < report.records.length; i++) {
      out.add(OvertimeRecordCard(
        record: report.records[i],
        number: _monthMode ? null : i + 1,
        showDate: _monthMode,
      ));
      out.add(const SizedBox(height: 10));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final String title;
    final String? subtitle;
    if (_monthMode) {
      title = '${overtimeMonthName(_month.month)} ${overtimeCount(_month.year)}';
      subtitle = null;
    } else {
      title = overtimeDateLabel(overtimeIsoDate(_day));
      subtitle = overtimeWeekdayName(_day);
    }

    final children = <Widget>[
      _personPickerCard(),
      const SizedBox(height: 14),
      Row(
        children: [
          _modeChip('تقرير يوم', false),
          const SizedBox(width: 8),
          _modeChip('تقرير شهر', true),
        ],
      ),
      const SizedBox(height: 12),
      OvertimePeriodBar(
        title: title,
        subtitle: subtitle,
        onPrevious: () => _shift(-1),
        onNext: () => _shift(1),
        onTap: _pickDate,
      ),
      const SizedBox(height: 14),
    ];

    final report = _report;
    if (_loading) {
      children.add(const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: CircularProgressIndicator(color: kOvertimeColor)),
      ));
    } else if (_error != null) {
      children.add(OvertimeErrorView(message: _error!, onRetry: _reload));
    } else if (report == null || report.records.isEmpty) {
      children.add(OvertimeEmptyState(
        icon: Icons.event_busy_outlined,
        text: _monthMode ? 'لا يوجد عمل إضافي مسجَّل في هذا الشهر.' : 'لا يوجد عمل إضافي مسجَّل في هذا اليوم.',
      ));
    } else {
      children.addAll(_reportBody(report));
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(20, 14, 20, 28),
        children: children,
      ),
    );
  }
}

/// ورقة اختيار وجهة ملخص واتساب: جوال المسؤول نفسه أو الجروب.
class _SendTargetSheet extends StatelessWidget {
  const _SendTargetSheet();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 18, 16, 20),
      decoration: const BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(4, 0, 4, 10),
              child: Text('إرسال ملخص التقرير على واتساب', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
            _targetTile(
              context,
              icon: Icons.phone_android_outlined,
              title: 'إلى جوالي',
              subtitle: 'يصل على الرقم المسجَّل في حسابك',
              toGroup: false,
            ),
            const SizedBox(height: 8),
            _targetTile(
              context,
              icon: Icons.groups_outlined,
              title: 'إلى جروب الصيانة',
              subtitle: 'جروب العمل الإضافي إن كان مضبوطًا، وإلا جروب الصيانة',
              toGroup: true,
            ),
          ],
        ),
      ),
    );
  }

  Widget _targetTile(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required bool toGroup,
  }) {
    return InkWell(
      onTap: () => Navigator.of(context).pop(toGroup),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: AppColors.surface,
          border: Border.all(color: AppColors.border),
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            Container(
              width: 42,
              height: 42,
              decoration: BoxDecoration(color: kOvertimeColor.withOpacity(0.12), borderRadius: BorderRadius.circular(12)),
              child: Icon(icon, color: kOvertimeColor),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: const TextStyle(fontSize: 12, color: AppColors.textMuted)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
