import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_report_print_screen.dart';
import 'overtime_widgets.dart';

/// كشف فرد واحد: تختار الفرد المسجَّل فتظهر لك الأيام التي شارك فيها في العمل
/// الإضافي، وساعاته في كل يوم والأعمال التي نفّذها، مع إجمالي مرّاته وأيامه
/// وساعاته — لشهر أو لسنة كاملة، ومعها كشف PDF للطباعة.
class OvertimePersonScreen extends StatefulWidget {
  final OvertimeEmployee employee;

  /// الشهر الذي يفتح عليه الكشف (يُؤخذ منه الشهر والسنة فقط).
  final DateTime initialMonth;

  const OvertimePersonScreen({super.key, required this.employee, required this.initialMonth});

  @override
  State<OvertimePersonScreen> createState() => _OvertimePersonScreenState();
}

class _OvertimePersonScreenState extends State<OvertimePersonScreen> {
  bool _yearMode = false;
  late DateTime _month;
  OvertimePersonReport? _report;
  bool _loading = true;
  String? _error;
  int _requestId = 0;

  @override
  void initState() {
    super.initState();
    _month = DateTime(widget.initialMonth.year, widget.initialMonth.month, 1);
    _load();
  }

  Future<void> _load() async {
    final id = ++_requestId;
    if (mounted) setState(() => _error = null);
    try {
      final report = _yearMode
          ? await OvertimeService.fetchPersonReport(widget.employee.id, year: _month.year.toString())
          : await OvertimeService.fetchPersonReport(widget.employee.id, month: overtimeIsoMonth(_month));
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

  void _setMode(bool year) {
    if (_yearMode == year) return;
    setState(() => _yearMode = year);
    _reload();
  }

  void _shift(int step) {
    setState(() {
      _month = _yearMode ? DateTime(_month.year + step, _month.month, 1) : DateTime(_month.year, _month.month + step, 1);
    });
    _reload();
  }

  Future<void> _pickMonth() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _month,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
      helpText: 'اختر أي يوم من الشهر المطلوب',
    );
    if (picked == null) return;
    setState(() => _month = DateTime(picked.year, picked.month, 1));
    _reload();
  }

  void _openPdf(OvertimePersonReport report) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => OvertimeReportPrintScreen.person(person: report)),
    );
  }

  // ---------------------------------- الواجهة ----------------------------------

  Widget _identityCard() {
    final e = widget.employee;
    final number = e.employeeNumber;
    final n = e.name.trim();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 22,
            backgroundColor: kOvertimeColor.withOpacity(0.1),
            child: Text(
              n.isEmpty ? '؟' : n.substring(0, 1),
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: kOvertimeColor),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(e.name, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                const SizedBox(height: 2),
                Text(
                  number == null ? 'بدون رقم وظيفي' : 'الرقم الوظيفي: ${overtimeNumberLabel(number)}',
                  style: const TextStyle(fontSize: 12.5, color: AppColors.textMuted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _modeChip(String label, bool year) {
    final selected = _yearMode == year;
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
      onSelected: (_) => _setMode(year),
    );
  }

  Widget _recordLine(OvertimeRecord r) {
    final parts = <String>[];
    if (r.startTime != null && r.endTime != null) {
      parts.add('من ${overtimeTimeLabel(r.startTime!)} إلى ${overtimeTimeLabel(r.endTime!)}');
      if (r.hours != null) parts.add(overtimeHoursLabel(r.hours!));
    }
    if (r.location != null) parts.add(r.location!);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 7),
            child: Icon(Icons.circle, size: 6, color: kOvertimeColor),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.workDescription, style: const TextStyle(fontSize: 13, height: 1.5)),
                if (parts.isNotEmpty)
                  Text(parts.join(' — '), style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _dayCard(OvertimePersonReport report, OvertimeDayStat d) {
    final date = overtimeParseDate(d.date);
    final weekday = date == null ? '' : overtimeWeekdayName(date);
    final recs = report.recordsOn(d.date);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        border: Border.all(color: AppColors.border),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(overtimeDateLabel(d.date), style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 2),
                    Text(
                      '$weekday — ${overtimeCount(d.recordsCount)} ${d.recordsCount == 1 ? 'عمل' : 'أعمال'}',
                      style: const TextStyle(fontSize: 12, color: AppColors.textMuted),
                    ),
                  ],
                ),
              ),
              if (d.hours > 0)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(color: kOvertimeColor.withOpacity(0.1), borderRadius: BorderRadius.circular(999)),
                  child: Text(
                    overtimeHoursLabel(d.hours),
                    style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: kOvertimeColor),
                  ),
                )
              else
                const Text('بلا وقت محدد', style: TextStyle(fontSize: 12, color: AppColors.textMuted)),
            ],
          ),
          for (final r in recs) _recordLine(r),
        ],
      ),
    );
  }

  List<Widget> _reportBody(OvertimePersonReport report) {
    final out = <Widget>[
      Row(
        children: [
          KpiCard(value: overtimeCount(report.recordsCount), label: 'مرات الإضافي', valueColor: AppColors.maintenance),
          const SizedBox(width: 10),
          KpiCard(value: overtimeCount(report.daysCount), label: 'عدد الأيام', valueColor: AppColors.maintenance),
          if (report.hours > 0) ...[
            const SizedBox(width: 10),
            KpiCard(
              value: overtimeHoursLabel(report.hours).replaceAll(' ساعة', ' س'),
              label: 'إجمالي الساعات',
              valueColor: kOvertimeColor,
            ),
          ],
        ],
      ),
      const SizedBox(height: 12),
      PrimaryButton(
        label: 'كشف الفرد PDF للطباعة',
        color: kOvertimeColor,
        icon: Icons.picture_as_pdf_outlined,
        onPressed: () => _openPdf(report),
      ),
    ];

    if (report.recordsWithoutHours > 0) {
      out.add(const SizedBox(height: 10));
      out.add(InfoNote(
        text: '${overtimeCount(report.recordsWithoutHours)} من الأعمال بلا وقت محدد، فلا تدخل ساعاتها في الإجماليات.',
        color: kOvertimeColor,
        icon: Icons.info_outline,
      ));
    }

    out.add(const SizedBox(height: 16));
    out.add(const OvertimeSectionTitle('الأيام وساعات كل يوم'));
    for (final d in report.days) {
      out.add(_dayCard(report, d));
      out.add(const SizedBox(height: 10));
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final String title = _yearMode
        ? overtimeCount(_month.year)
        : '${overtimeMonthName(_month.month)} ${overtimeCount(_month.year)}';

    final children = <Widget>[
      _identityCard(),
      const SizedBox(height: 12),
      Row(
        children: [
          _modeChip('شهر', false),
          const SizedBox(width: 8),
          _modeChip('سنة كاملة', true),
        ],
      ),
      const SizedBox(height: 12),
      OvertimePeriodBar(
        title: title,
        onPrevious: () => _shift(-1),
        onNext: () => _shift(1),
        onTap: _yearMode ? null : _pickMonth,
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
        text: _yearMode ? 'لم يشارك هذا الفرد في عمل إضافي خلال هذه السنة.' : 'لم يشارك هذا الفرد في عمل إضافي خلال هذا الشهر.',
      ));
    } else {
      children.addAll(_reportBody(report));
    }

    return Scaffold(
      appBar: const ScreenTopBar(title: 'كشف الفرد'),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 28),
            children: children,
          ),
        ),
      ),
    );
  }
}
