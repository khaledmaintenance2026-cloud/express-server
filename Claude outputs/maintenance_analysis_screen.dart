import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/maintenance_analysis.dart';
import '../../services/app_state.dart';
import '../../services/arabic_format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// صفحة "تحليل الصيانة" — طلب صريح من مسؤول الصيانة (2026-10-03): "كـ إدارة
/// الصيانة أريد صفحة للتحليل — المهام وعمل الفنيين"، ثم طلب متابعة بتاريخه
/// نفسه برفع المستوى البصري ("أريد أن يكون أكثر احترافية... وأشكال أكثر
/// تبيّن") وإضافة نفس التحليل لقسم "التقارير" (نُفِّذ في
/// maintenance_completed_screen.dart — شاشة "تقارير الصيانة" الفعلية رغم
/// اسم الملف — وفي services/maintenanceReport.js على السيرفر).
///
/// تعرض إحصائيات عامة عن أوامر العمل (الحالات، التوزيع حسب النوع كحلقة
/// دائرية ملوّنة، الاتجاه الزمني كأعمدة مع محور أرقام) وأداء كل فني (قائمة
/// مرتّبة بميداليات للثلاثة الأوائل، مع بطاقة "الأعلى أداءً" في الأعلى) خلال
/// فترة زمنية يختارها المستخدم — إما آخر ٣٠ يومًا (افتراضي) أو فترة مخصصة.
///
/// مصدر البيانات: GET /api/maintenance-analysis (راجع
/// routes/maintenanceAnalysis.js على السيرفر) — مقصور على مسؤول الصيانة
/// (ومدير النظام تلقائيًا) فقط؛ الدخول لهذه الشاشة نفسها مقصور بنفس الشرط من
/// maintenance_dashboard_screen.dart وmaintenance_completed_screen.dart
/// (أيقونة/بطاقة "تحليل الصيانة" لا تظهر لغيرهما).
///
/// بلا أي حزمة رسم بياني خارجية — الحلقة الدائرية مرسومة بـCustomPainter
/// بسيط (لا توجد أي حزمة من هذا النوع بالمشروع أصلًا)، وبقية الرسوم
/// Container/Row عادية بنفس أسلوب التطبيق في inventory_screen.dart.
enum _RangeMode { last30, custom }

class MaintenanceAnalysisScreen extends StatefulWidget {
  const MaintenanceAnalysisScreen({super.key});

  @override
  State<MaintenanceAnalysisScreen> createState() => _MaintenanceAnalysisScreenState();
}

class _MaintenanceAnalysisScreenState extends State<MaintenanceAnalysisScreen> {
  _RangeMode _mode = _RangeMode.last30;
  DateTime? _customFrom;
  DateTime? _customTo;
  bool _loading = true;
  String? _error;
  MaintenanceAnalysis? _data;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await context.read<AppState>().fetchMaintenanceAnalysis(
            from: _mode == _RangeMode.custom ? _customFrom : null,
            to: _mode == _RangeMode.custom ? _customTo : null,
          );
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'تعذّر تحميل التحليل: $e';
        _loading = false;
      });
    }
  }

  Future<void> _pickDate({required bool isFrom}) async {
    final now = DateTime.now();
    final initial = (isFrom ? _customFrom : _customTo) ?? now;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial.isAfter(now) ? now : initial,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
    );
    if (picked == null) return;
    setState(() {
      if (isFrom) {
        _customFrom = picked;
      } else {
        _customTo = picked;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      appBar: const ScreenTopBar(title: 'تحليل الصيانة'),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildRangeSelector(),
            const SizedBox(height: 16),
            Expanded(child: _buildBody()),
          ],
        ),
      ),
    );
  }

  Widget _buildRangeSelector() {
    final canApply = _customFrom != null && _customTo != null && !_customFrom!.isAfter(_customTo!);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(color: AppColors.divider, borderRadius: BorderRadius.circular(12)),
          child: Row(
            children: [
              Expanded(
                child: _Segment(
                  label: 'آخر ٣٠ يوم',
                  selected: _mode == _RangeMode.last30,
                  onTap: () {
                    if (_mode == _RangeMode.last30) return;
                    setState(() => _mode = _RangeMode.last30);
                    _load();
                  },
                ),
              ),
              Expanded(
                child: _Segment(
                  label: 'فترة مخصصة',
                  selected: _mode == _RangeMode.custom,
                  onTap: () => setState(() => _mode = _RangeMode.custom),
                ),
              ),
            ],
          ),
        ),
        if (_mode == _RangeMode.custom) ...[
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(child: _DateField(label: 'من تاريخ', value: _customFrom, onTap: () => _pickDate(isFrom: true))),
              const SizedBox(width: 10),
              Expanded(child: _DateField(label: 'إلى تاريخ', value: _customTo, onTap: () => _pickDate(isFrom: false))),
            ],
          ),
          const SizedBox(height: 10),
          if (!canApply) ...[
            const Text('اختر تاريخ البداية والنهاية ثم اضغط "تطبيق"', style: TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
            const SizedBox(height: 8),
          ],
          PrimaryButton(label: 'تطبيق', color: AppColors.maintenance, icon: Icons.check, onPressed: canApply ? _load : null),
        ],
      ],
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator(color: AppColors.maintenance));
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
              const SizedBox(height: 14),
              TextButton(onPressed: _load, child: const Text('إعادة المحاولة')),
            ],
          ),
        ),
      );
    }
    final data = _data;
    if (data == null) return const SizedBox.shrink();
    final s = data.summary;
    final avgLabel = s.avgResolutionMinutes != null ? ArabicFormat.duration(Duration(minutes: s.avgResolutionMinutes!)) : '—';
    final sortedTechs = [...data.technicians]..sort((a, b) => b.completedCount.compareTo(a.completedCount));
    final completionRate = s.total == 0 ? null : (s.completed * 100 / s.total).round();

    return ListView(
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.surface,
            borderRadius: BorderRadius.circular(14),
            boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: AppColors.maintenance.withOpacity(0.1), borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.date_range_outlined, size: 18, color: AppColors.maintenance),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'الفترة المعروضة: من ${ArabicFormat.date(data.from)} إلى ${ArabicFormat.date(data.to)}'
                  '${completionRate != null ? ' — أُنجز ٪${ArabicFormat.toEasternDigits(completionRate)} من الأوامر' : ''}',
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            _StatTile(icon: Icons.assignment_outlined, color: AppColors.maintenance, value: ArabicFormat.number(s.total), label: 'إجمالي الأوامر'),
            const SizedBox(width: 10),
            _StatTile(icon: Icons.check_circle_outline, color: AppColors.successText, value: ArabicFormat.number(s.completed), label: 'مُنجزة'),
            const SizedBox(width: 10),
            _StatTile(icon: Icons.timer_outlined, color: AppColors.maintenance, value: avgLabel, label: 'متوسط وقت الإصلاح'),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            _StatTile(icon: Icons.hourglass_bottom_outlined, color: AppColors.warningText, value: ArabicFormat.number(s.open), label: 'مفتوحة حاليًا'),
            const SizedBox(width: 10),
            _StatTile(icon: Icons.cancel_outlined, color: AppColors.textMuted, value: ArabicFormat.number(s.cancelled), label: 'ملغاة'),
            const SizedBox(width: 10),
            _StatTile(icon: Icons.groups_outlined, color: AppColors.maintenance, value: ArabicFormat.number(data.technicians.length), label: 'عدد الفنيين'),
          ],
        ),
        const SizedBox(height: 24),
        const _SectionHeader(icon: Icons.show_chart, color: AppColors.maintenance, text: 'الاتجاه الزمني'),
        const SizedBox(height: 10),
        _TrendChart(points: data.trend, bucket: data.bucket),
        const SizedBox(height: 24),
        const _SectionHeader(icon: Icons.donut_large_outlined, color: AppColors.maintenance, text: 'توزيع المهام حسب النوع'),
        const SizedBox(height: 10),
        _KindDonutChart(summary: s),
        const SizedBox(height: 24),
        const _SectionHeader(icon: Icons.leaderboard_outlined, color: AppColors.maintenance, text: 'أداء الفنيين'),
        const SizedBox(height: 10),
        if (sortedTechs.isEmpty)
          Container(
            padding: const EdgeInsets.all(16),
            alignment: Alignment.center,
            decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(14)),
            child: const Text('لا يوجد فنيون مسجّلون بعد', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
          )
        else ...[
          if (sortedTechs.first.completedCount > 0) ...[
            _TopPerformerCard(technician: sortedTechs.first),
            const SizedBox(height: 12),
          ],
          _TechnicianBarChart(technicians: sortedTechs),
        ],
        const SizedBox(height: 10),
      ],
    );
  }
}

class _SectionHeader extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String text;
  const _SectionHeader({required this.icon, required this.color, required this.text});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(9)),
          child: Icon(icon, size: 16, color: color),
        ),
        const SizedBox(width: 10),
        Text(text, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
      ],
    );
  }
}

/// بطاقة رقم سريع واحدة — أيقونة في دائرة ملوّنة + رقم كبير + تسمية، بظل خفيف
/// بدل إطار فقط (نفس درجة الظل المستخدمة في home_screen.dart) لمظهر أكثر
/// احترافية من KpiCard المشتركة المستخدمة في باقي الشاشات.
class _StatTile extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String value;
  final String label;
  const _StatTile({required this.icon, required this.color, required this.value, required this.label});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(9)),
              child: Icon(icon, size: 16, color: color),
            ),
            const SizedBox(height: 10),
            Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
            const SizedBox(height: 2),
            Text(label, style: const TextStyle(fontSize: 10.5, color: AppColors.textMuted), maxLines: 1, overflow: TextOverflow.ellipsis),
          ],
        ),
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _Segment({required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: selected ? AppColors.surface : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          boxShadow: selected ? [BoxShadow(color: Colors.black.withOpacity(0.06), blurRadius: 4)] : null,
        ),
        alignment: Alignment.center,
        child: Text(
          label,
          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: selected ? AppColors.maintenance : AppColors.textMuted),
        ),
      ),
    );
  }
}

class _DateField extends StatelessWidget {
  final String label;
  final DateTime? value;
  final VoidCallback onTap;
  const _DateField({required this.label, required this.value, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(color: AppColors.surface, border: Border.all(color: AppColors.border), borderRadius: BorderRadius.circular(12)),
        child: Row(
          children: [
            const Icon(Icons.calendar_today_outlined, size: 15, color: AppColors.textMuted),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                value != null ? ArabicFormat.date(value!) : label,
                style: TextStyle(fontSize: 12.5, color: value != null ? AppColors.textPrimary : AppColors.textFaint, fontWeight: FontWeight.w600),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// مخطط أعمدة لعدد أوامر العمل المُنشأة مقابل المُنجزة لكل نقطة زمنية (يوم أو
/// أسبوع حسب [bucket])، مع محور أرقام بسيط (القيمة القصوى + صفر) وخطين
/// إرشاديين أفقيين خفيفين خلف الأعمدة — يقرأ كرسم بياني حقيقي لا مجرد أشرطة
/// عائمة. بلا أي حزمة خارجية (Container/Stack عادية).
class _TrendChart extends StatelessWidget {
  final List<MaintenanceTrendPoint> points;
  final String bucket;
  const _TrendChart({required this.points, required this.bucket});

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return Container(
        padding: const EdgeInsets.all(20),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: AppColors.surface,
          borderRadius: BorderRadius.circular(16),
          boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
        ),
        child: const Text('لا توجد بيانات كافية خلال هذه الفترة', style: TextStyle(color: AppColors.textMuted, fontSize: 12.5)),
      );
    }
    final maxVal = points.fold<int>(1, (m, p) => [m, p.created, p.completed].reduce((a, b) => a > b ? a : b));
    // أكثر من ١٤ نقطة يصعب قراءتها كأعمدة منفصلة على شاشة جوال — نعرض آخر ١٤ فقط (الأحدث).
    final shown = points.length > 14 ? points.sublist(points.length - 14) : points;

    return Container(
      padding: const EdgeInsets.fromLTRB(14, 16, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            bucket == 'week' ? 'البيانات مجمّعة أسبوعيًا (الفترة أطول من ٦٠ يومًا)' : 'البيانات مجمّعة يوميًا',
            style: const TextStyle(fontSize: 10.5, color: AppColors.textFaint),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 130,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 24,
                  height: 130,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(ArabicFormat.number(maxVal), style: const TextStyle(fontSize: 9, color: AppColors.textFaint)),
                      const Text('٠', style: TextStyle(fontSize: 9, color: AppColors.textFaint)),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: SizedBox(
                    height: 130,
                    child: Stack(
                      children: [
                        Positioned.fill(
                          child: Column(
                            children: [
                              Expanded(child: Container()),
                              Container(height: 1, color: AppColors.divider),
                              Expanded(child: Container()),
                              Container(height: 1, color: AppColors.divider),
                              Expanded(child: Container()),
                            ],
                          ),
                        ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            for (final p in shown)
                              Expanded(
                                child: Tooltip(
                                  message:
                                      '${ArabicFormat.date(p.date)}\nأُنشئت: ${ArabicFormat.number(p.created)} — أُنجزت: ${ArabicFormat.number(p.completed)}',
                                  child: Row(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      _bar(p.created, maxVal, AppColors.maintenance.withOpacity(0.25)),
                                      const SizedBox(width: 2),
                                      _bar(p.completed, maxVal, AppColors.successText),
                                    ],
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              const SizedBox(width: 30),
              for (final p in shown)
                Expanded(
                  child: Text(
                    '${ArabicFormat.toEasternDigits(p.date.day)}/${ArabicFormat.toEasternDigits(p.date.month)}',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 9, color: AppColors.textFaint),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _legendDot(AppColors.maintenance.withOpacity(0.25), 'أُنشئت'),
              const SizedBox(width: 16),
              _legendDot(AppColors.successText, 'أُنجزت'),
            ],
          ),
        ],
      ),
    );
  }

  Widget _bar(int value, int maxVal, Color color) {
    final height = maxVal == 0 ? 0.0 : (value / maxVal) * 128;
    final clamped = value > 0 ? (height < 3 ? 3.0 : height) : 0.0;
    return Container(
      width: 7,
      height: clamped,
      decoration: BoxDecoration(color: color, borderRadius: const BorderRadius.vertical(top: Radius.circular(3))),
    );
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(width: 10, height: 10, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3))),
        const SizedBox(width: 6),
        Text(label, style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
      ],
    );
  }
}

/// بيانات فئة واحدة من فئات "توزيع المهام حسب النوع" — لون وأيقونة مميزان
/// لكل فئة (أحمر/تحذير للأعطال الطارئة، أخضر الإنتاج للوقائي باعتباره عملًا
/// استباقيًا صحيًا، كحلي الصيانة للمهام العامة) بدل لون واحد لكل الفئات كما
/// كانت النسخة الأولى من هذه الشاشة — تمييز بصري فوري بين الفئات الثلاث.
class _KindEntry {
  final String label;
  final int value;
  final Color color;
  final IconData icon;
  const _KindEntry(this.label, this.value, this.color, this.icon);
}

/// حلقة دائرية ملوّنة (Donut) لتوزيع المهام حسب النوع — رسم أكثر تميّزًا عن
/// بقية الأشرطة الأفقية بالشاشة، مرسومة بـCustomPainter بسيط بلا أي حزمة
/// خارجية، مع قائمة ألوان/أيقونات/نسب مئوية بجانبها.
class _KindDonutChart extends StatelessWidget {
  final MaintenanceAnalysisSummary summary;
  const _KindDonutChart({required this.summary});

  @override
  Widget build(BuildContext context) {
    final entries = [
      _KindEntry('أعطال طارئة', summary.emergencyCount, const Color(0xFFB3261E), Icons.warning_amber_rounded),
      _KindEntry('أعمال وقائية', summary.preventiveCount, AppColors.production, Icons.shield_outlined),
      _KindEntry('مهام عامة', summary.taskCount, AppColors.maintenance, Icons.assignment_outlined),
    ];
    final total = entries.fold<int>(0, (s, e) => s + e.value);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: 104,
            height: 104,
            child: Stack(
              alignment: Alignment.center,
              children: [
                CustomPaint(
                  size: const Size(104, 104),
                  painter: _DonutPainter(values: entries.map((e) => e.value.toDouble()).toList(), colors: entries.map((e) => e.color).toList()),
                ),
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(ArabicFormat.number(total), style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold, color: AppColors.textPrimary)),
                    const Text('إجمالي', style: TextStyle(fontSize: 10, color: AppColors.textMuted)),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (int i = 0; i < entries.length; i++) ...[
                  Row(
                    children: [
                      Icon(entries[i].icon, size: 14, color: entries[i].color),
                      const SizedBox(width: 6),
                      Expanded(child: Text(entries[i].label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600))),
                      Text(
                        '${ArabicFormat.number(entries[i].value)} (${total == 0 ? 0 : (entries[i].value * 100 / total).round()}٪)',
                        style: TextStyle(fontSize: 11, color: entries[i].color, fontWeight: FontWeight.w700),
                      ),
                    ],
                  ),
                  if (i != entries.length - 1) const SizedBox(height: 11),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DonutPainter extends CustomPainter {
  final List<double> values;
  final List<Color> colors;
  const _DonutPainter({required this.values, required this.colors});

  @override
  void paint(Canvas canvas, Size size) {
    const strokeWidth = 14.0;
    final total = values.fold<double>(0, (a, b) => a + b);
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.shortestSide - strokeWidth) / 2;
    final rect = Rect.fromCircle(center: center, radius: radius);

    if (total <= 0) {
      final bg = Paint()
        ..color = AppColors.divider
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round;
      canvas.drawArc(rect, 0, 2 * math.pi, false, bg);
      return;
    }

    final visibleCount = values.where((v) => v > 0).length;
    final gap = visibleCount > 1 ? 0.05 : 0.0;
    double start = -math.pi / 2;
    for (int i = 0; i < values.length; i++) {
      if (values[i] <= 0) continue;
      final sweep = (values[i] / total) * 2 * math.pi;
      final drawSweep = (sweep - gap).clamp(0.0, 2 * math.pi);
      final paint = Paint()
        ..color = colors[i]
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..strokeCap = StrokeCap.round;
      canvas.drawArc(rect, start, drawSweep, false, paint);
      start += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DonutPainter oldDelegate) => true;
}

/// بطاقة إبراز الفني الأعلى أداءً خلال الفترة المحددة — تظهر فوق قائمة
/// الفنيين الكاملة مباشرة، بلون ذهبي مطفي مميَّز عن بقية الشاشة.
class _TopPerformerCard extends StatelessWidget {
  final TechnicianPerformance technician;
  const _TopPerformerCard({required this.technician});

  @override
  Widget build(BuildContext context) {
    const gold = Color(0xFFC9A227);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: const Color(0xFFFFF8E8),
        border: Border.all(color: const Color(0xFFEBDCAC)),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Container(
            width: 42,
            height: 42,
            decoration: const BoxDecoration(color: Color(0x26C9A227), shape: BoxShape.circle),
            child: const Icon(Icons.emoji_events, color: gold),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('الأعلى أداءً خلال هذه الفترة', style: TextStyle(fontSize: 11, color: AppColors.textMuted)),
                Text(technician.name, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
              ],
            ),
          ),
          Text('${ArabicFormat.number(technician.completedCount)} مُنجزة', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.bold, color: gold)),
        ],
      ),
    );
  }
}

/// أداء الفنيين — قائمة مرتّبة تنازليًا بعدد المهام المُنجزة، مع شارة ترتيب
/// ملوّنة (ذهبي/فضي/برونزي للثلاثة الأوائل) وشريط أفقي نسبي لكل فني، ونص
/// إضافي تحته يوضح متوسط وقت الإنجاز وعدد المهام المفتوحة حاليًا.
class _TechnicianBarChart extends StatelessWidget {
  final List<TechnicianPerformance> technicians;
  const _TechnicianBarChart({required this.technicians});

  Color _rankColor(int rank) {
    switch (rank) {
      case 0:
        return const Color(0xFFC9A227);
      case 1:
        return const Color(0xFF9AA2AE);
      case 2:
        return const Color(0xFFB8793F);
      default:
        return AppColors.maintenance;
    }
  }

  @override
  Widget build(BuildContext context) {
    final maxVal = technicians.fold<int>(1, (m, t) => t.completedCount > m ? t.completedCount : m);

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 8, offset: const Offset(0, 2))],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (int i = 0; i < technicians.length; i++) ...[
            Row(
              children: [
                Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(color: _rankColor(i), shape: BoxShape.circle),
                  alignment: Alignment.center,
                  child: Text(
                    ArabicFormat.toEasternDigits(i + 1),
                    style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: Colors.white),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(child: Text(technicians[i].name, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
                const SizedBox(width: 8),
                Text('${ArabicFormat.number(technicians[i].completedCount)} مُنجزة', style: const TextStyle(fontSize: 11.5, color: AppColors.textMuted)),
              ],
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.only(right: 30),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: LayoutBuilder(
                  builder: (context, constraints) => Stack(
                    children: [
                      Container(height: 8, width: constraints.maxWidth, color: AppColors.divider),
                      Container(
                        height: 8,
                        width: constraints.maxWidth * (technicians[i].completedCount / maxVal),
                        color: _rankColor(i),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 5),
            Padding(
              padding: const EdgeInsets.only(right: 30),
              child: Text(
                [
                  technicians[i].openCount > 0 ? 'لديه ${ArabicFormat.number(technicians[i].openCount)} مهمة مفتوحة حاليًا' : 'لا توجد مهام مفتوحة حاليًا',
                  if (technicians[i].avgResolutionMinutes != null)
                    'متوسط الإنجاز ${ArabicFormat.duration(Duration(minutes: technicians[i].avgResolutionMinutes!))}',
                ].join(' — '),
                style: const TextStyle(fontSize: 11, color: AppColors.textFaint),
              ),
            ),
            if (i != technicians.length - 1) const SizedBox(height: 14),
          ],
        ],
      ),
    );
  }
}
