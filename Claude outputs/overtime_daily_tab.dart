import 'package:flutter/material.dart';

import '../../models/overtime.dart';
import '../../services/overtime_service.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'overtime_record_form_screen.dart';
import 'overtime_report_print_screen.dart';
import 'overtime_widgets.dart';

/// تبويب "السجل اليومي": يتنقّل المسؤول بين الأيام ويسجّل أعمال الإضافي (مع
/// الأفراد المشاركين) ويعدّلها ويحذفها، ويفتح "تقرير اليوم" للطباعة. حالة
/// التبويب (اليوم المختار والقائمة) محفوظة عند التنقل بين تبويبات الشاشة.
class OvertimeDailyTab extends StatefulWidget {
  const OvertimeDailyTab({super.key});

  @override
  State<OvertimeDailyTab> createState() => _OvertimeDailyTabState();
}

class _OvertimeDailyTabState extends State<OvertimeDailyTab> with AutomaticKeepAliveClientMixin {
  late DateTime _day;
  List<OvertimeRecord> _records = const [];
  bool _loading = true;
  String? _error;
  bool _openingReport = false;
  int _requestId = 0;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _day = DateTime(now.year, now.month, now.day);
    overtimeChanged.addListener(_onDataChanged);
    _load();
  }

  @override
  void dispose() {
    overtimeChanged.removeListener(_onDataChanged);
    super.dispose();
  }

  void _onDataChanged() {
    if (mounted) _load();
  }

  Future<void> _load() async {
    final id = ++_requestId;
    if (mounted) setState(() => _error = null);
    try {
      final list = await OvertimeService.fetchRecords(date: overtimeIsoDate(_day));
      if (!mounted || id != _requestId) return;
      setState(() {
        _records = list;
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

  void _setDay(DateTime d) {
    setState(() {
      _day = DateTime(d.year, d.month, d.day);
      _records = const [];
      _loading = true;
    });
    _load();
  }

  void _shift(int days) => _setDay(DateTime(_day.year, _day.month, _day.day + days));

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _day,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked != null) _setDay(picked);
  }

  bool get _isToday {
    final now = DateTime.now();
    return _day.year == now.year && _day.month == now.month && _day.day == now.day;
  }

  Future<void> _openForm({OvertimeRecord? existing}) async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => OvertimeRecordFormScreen(initialDate: _day, existing: existing)),
    );
    if (saved == true && mounted) {
      showOvertimeSnack(context, existing == null ? 'تم تسجيل العمل الإضافي' : 'تم حفظ التعديلات');
    }
  }

  Future<void> _confirmDelete(OvertimeRecord r) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('حذف العمل الإضافي؟'),
        content: Text('سيُحذف "${r.workDescription}" نهائيًا من سجل هذا اليوم وتقاريره.'),
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
      await OvertimeService.deleteRecord(r.id);
      if (!mounted) return;
      showOvertimeSnack(context, 'تم حذف العمل الإضافي');
      notifyOvertimeChanged();
    } catch (e) {
      if (!mounted) return;
      showOvertimeSnack(context, overtimeErrorText(e), error: true);
    }
  }

  Future<void> _openDayReport() async {
    if (_openingReport) return;
    setState(() => _openingReport = true);
    try {
      final report = await OvertimeService.fetchReport(date: overtimeIsoDate(_day));
      if (!mounted) return;
      setState(() => _openingReport = false);
      await Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => OvertimeReportPrintScreen(report: report)),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _openingReport = false);
      showOvertimeSnack(context, overtimeErrorText(e), error: true);
    }
  }

  /// عدد الأفراد المختلفين في اليوم (فرد واحد يعمل في أكثر من عمل يُحسب مرة).
  int get _distinctPeople {
    final keys = <String>{};
    for (final r in _records) {
      for (final e in r.entries) {
        keys.add(e.employeeId ?? 'n:${e.name}');
      }
    }
    return keys.length;
  }

  double get _personHours => _records.fold<double>(0, (sum, r) => sum + (r.personHours ?? 0));

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final dayLabel = overtimeDateLabel(overtimeIsoDate(_day));
    final subtitle = '${overtimeWeekdayName(_day)}${_isToday ? ' — اليوم' : ''}';

    final children = <Widget>[
      OvertimePeriodBar(
        title: dayLabel,
        subtitle: subtitle,
        onPrevious: () => _shift(-1),
        onNext: () => _shift(1),
        onTap: _pickDate,
      ),
      const SizedBox(height: 12),
    ];

    if (_loading) {
      children.add(const Padding(
        padding: EdgeInsets.symmetric(vertical: 48),
        child: Center(child: CircularProgressIndicator(color: kOvertimeColor)),
      ));
    } else if (_error != null) {
      children.add(OvertimeErrorView(message: _error!, onRetry: _load));
    } else if (_records.isEmpty) {
      children.add(const OvertimeEmptyState(
        icon: Icons.more_time_outlined,
        text: 'لا يوجد عمل إضافي مسجَّل في هذا اليوم.\nاضغط «إضافة عمل» لتسجيل أول عمل.',
      ));
    } else {
      children.add(Row(
        children: [
          KpiCard(value: overtimeCount(_records.length), label: 'عدد الأعمال', valueColor: AppColors.maintenance),
          const SizedBox(width: 10),
          KpiCard(value: overtimeCount(_distinctPeople), label: 'عدد الأفراد', valueColor: AppColors.maintenance),
          if (_personHours > 0) ...[
            const SizedBox(width: 10),
            KpiCard(value: overtimeHoursLabel(_personHours).replaceAll(' ساعة', ' س'), label: 'ساعات الأفراد', valueColor: kOvertimeColor),
          ],
        ],
      ));
      children.add(const SizedBox(height: 12));
      children.add(
        OutlinedButton.icon(
          onPressed: _openingReport ? null : _openDayReport,
          icon: _openingReport
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: kOvertimeColor))
              : const Icon(Icons.picture_as_pdf_outlined, size: 20),
          label: Text(_openingReport ? 'جارٍ تجهيز التقرير...' : 'تقرير اليوم (PDF للطباعة)'),
          style: OutlinedButton.styleFrom(
            foregroundColor: kOvertimeColor,
            side: const BorderSide(color: kOvertimeColor),
            padding: const EdgeInsets.symmetric(vertical: 13),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(13)),
          ),
        ),
      );
      children.add(const SizedBox(height: 14));
      for (var i = 0; i < _records.length; i++) {
        final r = _records[i];
        children.add(OvertimeRecordCard(
          record: r,
          number: i + 1,
          onEdit: () => _openForm(existing: r),
          onDelete: () => _confirmDelete(r),
        ));
        children.add(const SizedBox(height: 10));
      }
    }

    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(20, 14, 20, 96),
            children: children,
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
            icon: const Icon(Icons.add),
            label: const Text('إضافة عمل', style: TextStyle(fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }
}
